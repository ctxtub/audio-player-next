import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 *  场景隔离库直查助手（任务13 第二段）。
 *
 * 隔离库由 harness app-server 注入（快照内独占文件），路径经
 * `.e2e-runtime/browser-harness/app-handle-<runId>.json` 的 dbFile 字段
 * 本助手只读取当次隔离数据库，
 * 不自造库、不碰 prisma/dev.db）。
 *
 * 直查经 sqlite3 CLI 只读 SELECT（参数数组传参，不走 shell），由测试进程
 * 在页面关闭后执行，不靠页面内日志自证。
 */

/** harness 运行时目录（与 fixtures 同口径）。 */
const runtimeDir: string = join(process.cwd(), ".e2e-runtime", "browser-harness");

/** 允许直查的表白名单。 */
const allowedTables: readonly string[] = [
    "GuestGenerationHistory",
    "GuestPromptHistory",
    "GuestChatMessage",
    "GuestPlaybackAnchor",
    "GuestPlaybackProgress",
    "GenerationHistory",
    "PromptHistory",
    "ChatMessage",
    "UserPlaybackProgress",
];

/**
 * 允许夹具直写的表（仅隔离库，用于构造“旧历史卡”等  前置形态）。
 * 生产/开发库禁止任何写操作；dbFile 由 resolveIsolationDbPath 保证隔离。
 */
const allowedWriteTables: readonly string[] = ["GuestChatMessage", "GuestPlaybackProgress"];

/**
 * 解析当次运行的隔离库文件路径。
 * @param runId harness 运行标识
 * @returns 隔离库绝对路径
 */
export function resolveIsolationDbPath(runId: string): string {
    const handlePath: string = join(runtimeDir, `app-handle-${runId}.json`);
    const raw: string = readFileSync(handlePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const dbFile: unknown = (parsed as Record<string, unknown>)["dbFile"];
    if (typeof dbFile !== "string" || dbFile.length === 0) {
        throw new Error("[db-helper] app-handle 缺 dbFile 字段");
    }
    return dbFile;
}

/**
 * 对隔离库执行只读 SELECT 并返回 stdout 裁剪串。
 * @param dbFile 隔离库文件路径
 * @param sql 只读 SQL（调用方保证仅 SELECT 且表名已白名单校）
 * @returns stdout 文本
 */
function queryReadOnly(dbFile: string, sql: string): string {
    // `-cmd .timeout`： 可能在 App 正在写 checkpoint/anchor 时轮询读取，避免瞬时 locked 假失败；
    // 用 dot-command 而非 `PRAGMA busy_timeout`（后者会向 stdout 回显 "10000" 污染结果）。
    const out: string = execFileSync("sqlite3", ["-cmd", ".timeout 10000", dbFile, sql], {
        encoding: "utf8",
        timeout: 15000,
    });
    return out.trim();
}

/**
 * 转义 SQL 单引号字面量。
 * @param value 原始字符串
 * @returns 转义后可嵌入单引号的字面量
 */
function escapeLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

/**
 * 统计单表总行数（隔离库内仅当次运行数据，无需按 guestId 过滤）。
 * @param dbFile 隔离库文件路径
 * @param table 表名（白名单内）
 * @returns 行数
 */
export function countTableRows(dbFile: string, table: string): number {
    if (!allowedTables.includes(table)) {
        throw new Error(`[db-helper] 非法表名：${table}`);
    }
    const out: string = queryReadOnly(dbFile, `SELECT COUNT(*) FROM "${table}";`);
    return Number(out);
}

/**
 * 访客聊天是否含指定片段（尾部落库内容断言）。
 * @param dbFile 隔离库文件路径
 * @param fragment 内容片段（转义后 LIKE 匹配）
 * @returns 命中返回 true
 */
export function guestChatContains(dbFile: string, fragment: string): boolean {
    const out: string = queryReadOnly(
        dbFile,
        `SELECT COUNT(*) FROM GuestChatMessage WHERE content LIKE '%${escapeLiteral(fragment)}%';`,
    );
    return Number(out) > 0;
}

/**
 * 访客聊天行角色与内容头快照（Fix 8 诊断：定位尾部缺失发生在“行缺失”还是“内容变形”）。
 * 仅返回 role 与 content 前 24 字，不扩散完整正文。
 * @param dbFile 隔离库文件路径
 * @returns 行快照数组
 */
export function guestChatRowSnapshot(dbFile: string): Array<{ role: string; head: string }> {
    const out: string = queryReadOnly(dbFile, 'SELECT role || char(31) || substr(content, 1, 24) FROM GuestChatMessage ORDER BY id ASC;');
    if (out.length === 0) {
        return [];
    }
    return out.split('\n').map((line) => {
        const parts: string[] = line.split('');
        return { role: parts[0] ?? '', head: parts[1] ?? '' };
    });
}

/**
 * 按提示词精确查询访客生成历史（含故事正文，供回放 source/text 匹配断言）。
 * @param dbFile 隔离库文件路径
 * @param prompt 提示词原文
 * @returns 命中行（id/prompt/storyText）
 */
export function findGuestGenerationsByPrompt(
    dbFile: string,
    prompt: string,
): Array<{ id: number; prompt: string; storyText: string }> {
    const out: string = queryReadOnly(
        dbFile,
        `SELECT id || char(31) || prompt || char(31) || substr(storyText, 1, 2000) FROM GuestGenerationHistory WHERE prompt = '${escapeLiteral(prompt)}' ORDER BY id ASC;`,
    );
    if (out.length === 0) {
        return [];
    }
    const rows: Array<{ id: number; prompt: string; storyText: string }> = [];
    for (const line of out.split("\n")) {
        const parts: string[] = line.split("");
        if (parts.length < 3) {
            continue;
        }
        rows.push({
            id: Number(parts[0]),
            prompt: parts[1] ?? "",
            storyText: parts[2] ?? "",
        });
    }
    return rows;
}

/** 隔离库内某次生成对应访客的首个 assistant 消息 id 子查询（按提示词定位 guestId）。 */
function assistantMessageSubquery(prompt: string): string {
    return `SELECT m.id FROM GuestChatMessage m JOIN GuestGenerationHistory g ON g.guestId = m.guestId WHERE g.prompt = '${escapeLiteral(prompt)}' AND m.role = 'assistant' ORDER BY m.position ASC LIMIT 1`;
}

/**
 * 校验写目标表白名单（fail-closed）。
 * @param table 表名
 */
function assertWriteTable(table: string): void {
    if (!allowedWriteTables.includes(table)) {
        throw new Error(`[db-helper] 非法写表名：${table}`);
    }
}

/**
 * 对隔离库执行写语句（busy_timeout 防 App 连接短暂锁库；仅夹具前置）。
 * @param dbFile 隔离库文件路径
 * @param table 目标表（白名单校）
 * @param sql 写 SQL（调用方保证仅本次隔离库）
 */
function execWrite(dbFile: string, table: string, sql: string): void {
    assertWriteTable(table);
    execFileSync("sqlite3", ["-cmd", ".timeout 10000", dbFile, sql], {
        encoding: "utf8",
        timeout: 20000,
    });
}

/**
 * 将某次生成的 assistant 消息改写为 Legacy storyCard 形态（模拟旧历史卡）。
 * 服务端对“新增 legacy storyCard 写入”有 guard（，故此夹具只经隔离库直写，
 * 用于验证渲染/播放的只读兼容路径。
 * @param dbFile 隔离库文件路径
 * @param prompt 该次生成的唯一提示词
 * @param audioUrl Legacy 持久音频地址（可为空串）
 * @returns 被改写的消息正文（storyCard.storyText）
 */
export function seedLegacyStoryCardPartsByPrompt(
    dbFile: string,
    prompt: string,
    audioUrl: string,
): string {
    const subquery: string = assistantMessageSubquery(prompt);
    const storyText: string = queryReadOnly(
        dbFile,
        `SELECT content FROM GuestChatMessage WHERE id = (${subquery});`,
    );
    if (storyText.length === 0) {
        throw new Error("[db-helper] 未找到该提示词对应的 assistant 消息，无法植入 Legacy 卡");
    }
    const parts: string = JSON.stringify([{ type: "storyCard", storyText, audioUrl }]);
    execWrite(
        dbFile,
        "GuestChatMessage",
        `UPDATE GuestChatMessage SET parts = '${escapeLiteral(parts)}' WHERE id = (${subquery});`,
    );
    return storyText;
}

/**
 * 删除某次生成对应访客的播放 Anchor（清理 autoplay 建立的预置 Session，
 * 使  从“无 Session”冷态验证 StoryCard 播放入口）。
 * @param dbFile 隔离库文件路径
 * @param prompt 该次生成的唯一提示词
 */
export function deleteGuestPlaybackAnchorByPrompt(dbFile: string, prompt: string): void {
    execWrite(
        dbFile,
        "GuestPlaybackProgress",
        `DELETE FROM GuestPlaybackProgress WHERE guestId = (SELECT guestId FROM GuestGenerationHistory WHERE prompt = '${escapeLiteral(prompt)}' LIMIT 1);`,
    );
}

/**
 * 读取某次生成对应访客的 Anchor 身份（验证正式 Session 已落库）。
 * @param dbFile 隔离库文件路径
 * @param prompt 该次生成的唯一提示词
 * @returns Anchor 身份（无 Anchor 返回 null）
 */
export function readGuestPlaybackAnchorByPrompt(
    dbFile: string,
    prompt: string,
): { sourceKind: string; sourceId: string; anchorState: string; sessionId: string } | null {
    const out: string = queryReadOnly(
        dbFile,
        `SELECT COALESCE(sourceType,'') || char(31) || COALESCE(sourceId,'') || char(31) || COALESCE(anchorState,'') || char(31) || COALESCE(sessionId,'') FROM GuestPlaybackProgress WHERE guestId = (SELECT guestId FROM GuestGenerationHistory WHERE prompt = '${escapeLiteral(prompt)}' LIMIT 1);`,
    );
    if (out.length === 0) {
        return null;
    }
    const parts: string[] = out.split(String.fromCharCode(31));
    return {
        sourceKind: parts[0] ?? "",
        sourceId: parts[1] ?? "",
        anchorState: parts[2] ?? "",
        sessionId: parts[3] ?? "",
    };
}
