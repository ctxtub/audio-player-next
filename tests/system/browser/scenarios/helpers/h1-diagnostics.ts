/**
 * M10-05-H1 诊断采集（test-only，低扰动）。
 *
 * 背景：`story-playback-global-controls-reachable.spec.ts` 的 Gen-History Work
 * replay oracle 在 full-suite WebKit 下偶发 `Anchor kind` 仍为 `draft`。本模块
 * 只做观测，不改变任何产品行为、控制流、断言、timeout 或等待条件。
 *
 * 采集面（全部只读 / 被动）：
 * 1. 网络：page request/response/requestfailed 上所有 `playback.*` tRPC 调用
 *    （method / procedure / 输入 / HTTP 状态 / 响应体），用于还原 server Anchor
 *    的真实身份写入顺序（谁先谁后、是否 429/错误、是否有晚到 draft begin）。
 * 2. 页面内 Probe：轮询既有 E2E-only `window.__M5PlaybackProbe.snapshot()`，
 *    **仅在签名变化时**通过 exposeFunction 回传（无状态变化零事件）；并挂一个
 *    捕获阶段 click 监听，记录真实被点的 UI history item 身份。
 * 3. 节点快照：显式在关键节点读 server Anchor + 该 prompt 的 Work rows
 *    （只读 SELECT），并附 Probe 快照。
 *
 * 时间线：node 侧以 `performance.now()` 单调毫秒；页面事件按安装时的
 * node/page 偏移映射到同一 node 时间线。
 *
 * 产出：仅当用例 FAIL 时写 artifact（`testInfo.outputPath` + 稳定副本 + attach
 * + 控制台路径）；PASS 时全部丢弃，不写文件、不打印。
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";

/** 事件环形缓冲上限（防极端情况内存膨胀）。 */
const RING_CAP = 5000;

/** 页面内 Probe 采样间隔（毫秒；纯内存读取，仅在签名变化时回传）。 */
const PROBE_SAMPLE_INTERVAL_MS = 100;

/** 单个字符串字段最大保留长度（脱敏/防正文外溢）。 */
const STRING_LIMIT = 160;

/** server Anchor 只读快照形态。 */
export interface H1AnchorSnapshot {
    id: number | null;
    sourceType: string;
    sourceId: string;
    sessionId: string;
    anchorState: string;
    nextParagraphIndex: number | null;
    totalParagraphs: number | null;
    contentHash: string;
    updatedAt: string;
}

/** 当前 prompt 名下 Work row（顺序 / 晚到插入判定用）。 */
export interface H1WorkRow {
    id: number;
    createdAt: string;
    updatedAt: string;
    sourceMessageId: string;
    deletedAt: string;
}

/** 单个时间线事件。 */
interface H1Event {
    /** node 单调毫秒（自诊断开始）。 */
    t_ms: number;
    /** 墙钟 UTC（仅用于与外部日志对齐）。 */
    wall_utc: string;
    /** 事件来源。 */
    channel: "node" | "page" | "network";
    /** 事件类型。 */
    type: string;
    /** 可选标签。 */
    label?: string;
    /** 结构化细节（已脱敏）。 */
    detail?: unknown;
}

/** createH1Diagnostics 参数。 */
export interface H1DiagnosticsOptions {
    /** 当次 run 的隔离库路径（只读 SELECT）。 */
    dbFile: string;
    /** 当次 run 标识（稳定副本目录用）。 */
    runId: string;
}

/** 诊断句柄。 */
export interface H1Diagnostics {
    /** 设置/更新当前 prompt（generateStory 之后才知道）。 */
    setPrompt(prompt: string): void;
    /** 记录一个带完整快照的节点。 */
    mark(label: string, detail?: unknown): Promise<Record<string, unknown>>;
    /** 安装页面内 Probe 采样 + click 捕获（幂等；导航后需重装）。 */
    attachInPage(): Promise<void>;
    /** 收尾：FAIL 时写 artifact，PASS 时丢弃。 */
    finalize(testInfo: TestInfo): Promise<void>;
    /** 诊断计数摘要（供 PASS 路径记一条轻量 evidence step）。 */
    summary(): Record<string, unknown>;
}

/**
 * 脱敏：截断长字符串，剔除故事正文/切分段等大字段。
 * @param value 任意 JSON 值
 * @param depth 当前深度
 * @returns 脱敏后的值
 */
function sanitize(value: unknown, depth = 0): unknown {
    if (depth > 6) return "<deep>";
    if (typeof value === "string") {
        return value.length > STRING_LIMIT ? `${value.slice(0, STRING_LIMIT)}…` : value;
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
    if (typeof value === "undefined") return null;
    if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
    if (typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (k === "storyText" || k === "paragraphs" || k === "segments" || k === "content") {
                out[k] = "<omitted>";
                continue;
            }
            out[k] = sanitize(v, depth + 1);
        }
        return out;
    }
    return String(value);
}

/**
 * 转义 SQL 单引号字面量。
 * @param value 原始串
 * @returns 可嵌入单引号的字面量
 */
function escapeLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

/**
 * 只读 SELECT（sqlite3 CLI；busy_timeout 防与 App 写入瞬时锁库）。
 * @param dbFile 隔离库路径
 * @param sql 只读 SQL
 * @returns stdout 裁剪串（失败返回 null，不抛）
 */
function readOnlySelect(dbFile: string, sql: string): string | null {
    try {
        const out: string = execFileSync("sqlite3", ["-cmd", ".timeout 5000", dbFile, sql], {
            encoding: "utf8",
            timeout: 12000,
        });
        return out.trim();
    } catch {
        return null;
    }
}

/**
 * 读 server Anchor 身份（含行 id / updatedAt；无行或读失败返回带标记对象）。
 * @param dbFile 隔离库路径
 * @param prompt 提示词
 * @returns 快照
 */
function readAnchorSnapshot(
    dbFile: string,
    prompt: string,
): H1AnchorSnapshot | { error: string } {
    const sql = `SELECT id || char(31) || COALESCE(sourceType,'') || char(31) || COALESCE(sourceId,'') || char(31) || COALESCE(sessionId,'') || char(31) || COALESCE(anchorState,'') || char(31) || COALESCE(nextParagraphIndex,'') || char(31) || COALESCE(totalParagraphs,'') || char(31) || COALESCE(contentHash,'') || char(31) || COALESCE(updatedAt,'') FROM GuestPlaybackProgress WHERE guestId = (SELECT guestId FROM GuestGenerationHistory WHERE prompt = '${escapeLiteral(prompt)}' LIMIT 1);`;
    const out = readOnlySelect(dbFile, sql);
    if (out === null) return { error: "db-read-failed-or-locked" };
    if (out.length === 0) {
        return {
            id: null,
            sourceType: "",
            sourceId: "",
            sessionId: "",
            anchorState: "",
            nextParagraphIndex: null,
            totalParagraphs: null,
            contentHash: "",
            updatedAt: "",
        };
    }
    const p = out.split(String.fromCharCode(31));
    const asNum = (v?: string): number | null => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };
    return {
        id: asNum(p[0]),
        sourceType: p[1] ?? "",
        sourceId: p[2] ?? "",
        sessionId: p[3] ?? "",
        anchorState: p[4] ?? "",
        nextParagraphIndex: asNum(p[5]),
        totalParagraphs: asNum(p[6]),
        contentHash: p[7] ?? "",
        updatedAt: p[8] ?? "",
    };
}

/**
 * 读当前 prompt 名下 Work rows（id + 时间字段 + sourceMessageId）。
 * @param dbFile 隔离库路径
 * @param prompt 提示词
 * @returns rows 或带 error 的对象
 */
function readWorkRows(dbFile: string, prompt: string): H1WorkRow[] | { error: string } {
    const sql = `SELECT id || char(31) || COALESCE(createdAt,'') || char(31) || COALESCE(updatedAt,'') || char(31) || COALESCE(sourceMessageId,'') || char(31) || COALESCE(deletedAt,'') FROM GuestGenerationHistory WHERE prompt = '${escapeLiteral(prompt)}' ORDER BY id ASC;`;
    const out = readOnlySelect(dbFile, sql);
    if (out === null) return { error: "db-read-failed-or-locked" };
    if (out.length === 0) return [];
    return out.split("\n").map((line) => {
        const p = line.split(String.fromCharCode(31));
        return {
            id: Number(p[0]),
            createdAt: p[1] ?? "",
            updatedAt: p[2] ?? "",
            sourceMessageId: p[3] ?? "",
            deletedAt: p[4] ?? "",
        };
    });
}

/** 从 tRPC URL 解析全部 procedure 名。 */
function parseProcedures(url: string): string[] {
    const found: string[] = [];
    const re = /playback\.([A-Za-z]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(url)) !== null) {
        if (m[1] && !found.includes(m[1])) found.push(m[1]);
    }
    return found;
}

/**
 * 创建 H1 诊断句柄。
 * @param page Playwright 页面
 * @param options 隔离库 + runId
 * @returns 诊断句柄
 */
export function createH1Diagnostics(page: Page, options: H1DiagnosticsOptions): H1Diagnostics {
    const t0: number = performance.now();
    const events: H1Event[] = [];
    let prompt = "";
    let dropped = 0;
    const counts: Record<string, number> = { network: 0, page: 0, node: 0, probeChanges: 0, clicks: 0 };

    /** node 单调毫秒。 */
    const nowMs = (): number => performance.now() - t0;

    /** 入队（环形丢弃最旧并计数）。 */
    const push = (ev: Omit<H1Event, "t_ms" | "wall_utc"> & { t_ms?: number }): void => {
        counts[ev.channel] = (counts[ev.channel] ?? 0) + 1;
        if (events.length >= RING_CAP) {
            events.shift();
            dropped += 1;
        }
        events.push({
            t_ms: typeof ev.t_ms === "number" ? ev.t_ms : nowMs(),
            wall_utc: new Date().toISOString(),
            channel: ev.channel,
            type: ev.type,
            label: ev.label,
            detail: ev.detail === undefined ? undefined : sanitize(ev.detail),
        });
    };

    // —— 页面内事件回传（Probe 变化 / click） ——
    // 注意：exposeFunction 绑定随导航销毁，必须在最终页安装页面内采样时重新暴露。
    let pageInstallNodeMs: number | null = null;
    let pageInstallPageMs: number | null = null;

    /**
     * 在页面内事件回传（页面会经 `window.__h1NodeRecord` 调用）。
     * @param raw 页面回传条目 { t, type, payload }
     */
    const onPageEvent = (raw: unknown): void => {
        const entry = raw as { t?: unknown; type?: unknown; payload?: unknown } | null;
        if (!entry || typeof entry !== "object") return;
        const pageT = typeof entry.t === "number" ? entry.t : null;
        let tMs = nowMs();
        if (pageT !== null && pageInstallNodeMs !== null && pageInstallPageMs !== null) {
            tMs = pageInstallNodeMs + (pageT - pageInstallPageMs);
        }
        const type = typeof entry.type === "string" ? entry.type : "page-event";
        if (type === "probe-change") counts.probeChanges = (counts.probeChanges ?? 0) + 1;
        if (type === "click") counts.clicks = (counts.clicks ?? 0) + 1;
        push({ t_ms: tMs, channel: "page", type, detail: entry.payload });
    };

    // —— 网络：playback.* 全量 ——
    page.on("request", (request) => {
        const url = request.url();
        const procs = parseProcedures(url);
        if (procs.length === 0) return;
        let postData: unknown = null;
        try {
            postData = request.postDataJSON();
        } catch {
            postData = request.postData();
        }
        push({
            channel: "network",
            type: "request",
            label: procs.join(","),
            detail: { method: request.method(), procs, postData },
        });
    });
    page.on("response", (response) => {
        const url = response.url();
        const procs = parseProcedures(url);
        if (procs.length === 0) return;
        const status = response.status();
        void response
            .json()
            .then((body: unknown) => {
                push({
                    channel: "network",
                    type: "response",
                    label: procs.join(","),
                    detail: { status, procs, body },
                });
            })
            .catch(() => {
                push({
                    channel: "network",
                    type: "response-unreadable",
                    label: procs.join(","),
                    detail: { status, procs },
                });
            });
    });
    page.on("requestfailed", (request) => {
        const procs = parseProcedures(request.url());
        if (procs.length === 0) return;
        push({
            channel: "network",
            type: "requestfailed",
            label: procs.join(","),
            detail: { method: request.method(), failure: request.failure()?.errorText ?? "unknown" },
        });
    });

    /** 页面内读 Probe 快照（失败返回 null / error）。 */
    const readProbe = async (): Promise<unknown> => {
        try {
            return await page.evaluate(() => {
                const w = window as unknown as Record<string, unknown>;
                const probe = w["__M5PlaybackProbe"] as { snapshot?: () => unknown } | undefined;
                if (!probe || typeof probe.snapshot !== "function") return { probe: "absent" };
                try {
                    return { probe: "ready", snapshot: probe.snapshot() };
                } catch {
                    return { probe: "error" };
                }
            });
        } catch (err) {
            return { probe: "evaluate-failed", error: String(err).slice(0, 120) };
        }
    };

    /** 页面内读生成历史列表（当前点击候选身份）。 */
    const readHistoryItems = async (): Promise<unknown> => {
        try {
            return await page.evaluate(() => {
                const nodes = Array.from(document.querySelectorAll('[class*="historyItem"]'));
                return nodes.slice(0, 30).map((n, i) => ({
                    index: i,
                    text: (n.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
                    replayButtons: n.querySelectorAll('button[aria-label="回放此故事"]').length,
                    deleteButtons: n.querySelectorAll('button[aria-label="删除此历史"]').length,
                }));
            });
        } catch (err) {
            return { error: String(err).slice(0, 120) };
        }
    };

    const snapshot = async (label: string, detail?: unknown): Promise<Record<string, unknown>> => {
        const [probe, historyItems] = await Promise.all([readProbe(), readHistoryItems()]);
        const snap: Record<string, unknown> = {
            label,
            t_ms: Math.round(nowMs()),
            wall_utc: new Date().toISOString(),
            promptTail: prompt.length > 24 ? prompt.slice(-24) : prompt,
            detail: detail === undefined ? null : sanitize(detail),
            probe,
            anchor: prompt.length > 0 ? readAnchorSnapshot(options.dbFile, prompt) : "<no-prompt>",
            workRows: prompt.length > 0 ? readWorkRows(options.dbFile, prompt) : "<no-prompt>",
            uiHistoryItems: historyItems,
        };
        push({ channel: "node", type: "snapshot", label, detail: snap });
        return snap;
    };

    return {
        setPrompt(next: string): void {
            prompt = next;
            push({ channel: "node", type: "prompt-set", detail: { promptTail: next.slice(-24) } });
        },
        mark(label: string, detail?: unknown): Promise<Record<string, unknown>> {
            return snapshot(label, detail);
        },
        async attachInPage(): Promise<void> {
            try {
                // 导航后重新暴露回传通道（同名重复暴露由 Playwright 覆盖）。
                await page.exposeFunction("__h1NodeRecord", onPageEvent);
            } catch (err) {
                push({
                    channel: "node",
                    type: "expose-failed",
                    detail: { error: String(err).slice(0, 200) },
                });
            }
            try {
                const installed = await page.evaluate(
                    (intervalMs: number) => {
                        const w = window as unknown as Record<string, unknown>;
                        if (w["__h1Installed"] === true) return false;
                        w["__h1Installed"] = true;

                        const sigOf = (): string | null => {
                            const probe = w["__M5PlaybackProbe"] as
                                | { snapshot?: () => Record<string, unknown> }
                                | undefined;
                            if (!probe || typeof probe.snapshot !== "function") return null;
                            try {
                                const s = probe.snapshot();
                                const src = (s["source"] ?? null) as Record<string, unknown> | null;
                                const transport = (s["transport"] ?? null) as Record<string, unknown> | null;
                                return JSON.stringify({
                                    kind: src ? src["kind"] ?? null : null,
                                    workId: src ? src["workId"] ?? null : null,
                                    messageId: src ? src["messageId"] ?? null : null,
                                    status: s["status"] ?? null,
                                    sessionId: s["sessionId"] ?? null,
                                    continuationMode: s["continuationMode"] ?? null,
                                    nextParagraphIndex: s["nextParagraphIndex"] ?? null,
                                    totalParagraphs: s["totalParagraphs"] ?? null,
                                    isPlaying: transport ? transport["isPlaying"] ?? null : null,
                                    hasAudioUrl: transport ? transport["hasAudioUrl"] ?? null : null,
                                });
                            } catch {
                                return "error";
                            }
                        };

                        const record = w["__h1NodeRecord"] as
                            | ((entry: unknown) => void)
                            | undefined;
                        const emit = (entry: unknown): void => {
                            if (typeof record === "function") {
                                try {
                                    record(entry);
                                } catch {
                                    // 回传失败不影响页面。
                                }
                            }
                        };

                        let last = "";
                        const sample = (): void => {
                            const sig = sigOf();
                            if (sig === null || sig === last) return;
                            last = sig;
                            let payload: unknown = null;
                            try {
                                payload = JSON.parse(sig);
                            } catch {
                                payload = sig;
                            }
                            emit({ t: performance.now(), type: "probe-change", payload });
                        };
                        const timer = window.setInterval(sample, intervalMs);
                        w["__h1StopProbe"] = (): void => window.clearInterval(timer);
                        sample();

                        document.addEventListener(
                            "click",
                            (event) => {
                                const target = event.target;
                                if (!(target instanceof Element)) return;
                                const button = target.closest("button");
                                const item = target.closest('[class*="historyItem"]');
                                const items = Array.from(
                                    document.querySelectorAll('[class*="historyItem"]'),
                                );
                                emit({
                                    t: performance.now(),
                                    type: "click",
                                    payload: {
                                        ariaLabel: button ? button.getAttribute("aria-label") : null,
                                        buttonText: button
                                            ? (button.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60)
                                            : null,
                                        itemIndex: item ? items.indexOf(item) : null,
                                        itemCount: items.length,
                                        itemText: item
                                            ? (item.textContent ?? "")
                                                  .replace(/\s+/g, " ")
                                                  .trim()
                                                  .slice(0, 160)
                                            : null,
                                        itemList: items.slice(0, 30).map((n, i) => ({
                                            index: i,
                                            text: (n.textContent ?? "")
                                                .replace(/\s+/g, " ")
                                                .trim()
                                                .slice(0, 100),
                                        })),
                                    },
                                });
                            },
                            true,
                        );
                        return true;
                    },
                    PROBE_SAMPLE_INTERVAL_MS,
                );
                if (installed === true) {
                    pageInstallNodeMs = nowMs();
                    pageInstallPageMs = await page.evaluate(() => performance.now());
                    push({
                        channel: "node",
                        type: "in-page-instrumented",
                        detail: { intervalMs: PROBE_SAMPLE_INTERVAL_MS },
                    });
                }
            } catch (err) {
                push({
                    channel: "node",
                    type: "in-page-instrument-failed",
                    detail: { error: String(err).slice(0, 200) },
                });
            }
        },
        async finalize(testInfo: TestInfo): Promise<void> {
            const failed = testInfo.status !== "passed" && testInfo.status !== "skipped";
            // 终态快照（best-effort；页面可能已不可用，节点/网络事件仍在内存）。
            const finalSnap = await snapshot(`finalize:${testInfo.status}`);
            if (!failed) {
                // PASS：丢弃全部采集，不写文件、不打印。
                return;
            }
            const artifact = {
                schema: "m10-05-h1-diagnostics-v1",
                generated_at_utc: new Date().toISOString(),
                test: {
                    title: testInfo.title,
                    titlePath: testInfo.titlePath,
                    project: testInfo.project.name,
                    status: testInfo.status,
                    expectedStatus: testInfo.expectedStatus,
                    retry: testInfo.retry,
                },
                runId: options.runId,
                dbFile: options.dbFile,
                promptTail: prompt.length > 24 ? prompt.slice(-24) : prompt,
                counts: { ...counts, droppedEvents: dropped, totalEvents: events.length },
                timeline: events,
                finalSnapshot: finalSnap,
            };
            const body = `${JSON.stringify(artifact, null, 2)}\n`;
            const written: string[] = [];
            try {
                const primary = testInfo.outputPath("h1-diagnostics.json");
                writeFileSync(primary, body);
                written.push(primary);
            } catch {
                // 继续尝试稳定副本。
            }
            try {
                const dir = join(
                    process.cwd(),
                    ".e2e-results",
                    "browser",
                    options.runId,
                    `${testInfo.project.name}__h1-diagnostics`,
                );
                mkdirSync(dir, { recursive: true });
                const stable = join(dir, "h1-diagnostics.json");
                writeFileSync(stable, body);
                written.push(stable);
            } catch {
                // 稳定副本失败不掩盖原始 artifact。
            }
            try {
                await testInfo.attach("h1-diagnostics", {
                    body,
                    contentType: "application/json",
                });
            } catch {
                // attach 失败无碍（文件已落盘）。
            }
            // 失败时才输出 artifact 路径与关键计数。
            console.log(
                `[h1-diagnostics] FAIL artifact=${written.join(" | ") || "<none>"} counts=${JSON.stringify(counts)} totalEvents=${events.length}`,
            );
        },
        summary(): Record<string, unknown> {
            return {
                counts: { ...counts, droppedEvents: dropped, totalEvents: events.length },
                probeReady: pageInstallPageMs !== null,
            };
        },
    };
}
