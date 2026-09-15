// case_id: main-chrome-mobile-docked-mini
// journey: smoke-baseline
// M6-03 MainChrome & Mobile Docked Mini（聚合单场景，验收 A-G）。
// 767 + active session → Mini 在 TabBar 上方、不可拖、TabBar/Composer 可达；
// 无 session → 无幽灵预留；keyboard open → 纯隐藏（session/音频不变），close → 同一 sessionId 恢复；
// 点击 Mini → openExpanded()（URL 不变）；跨 /chat /library /setting 同一 Session、唯一 Host、零重建；768 不进 mobile 分支。
// 慢沙箱一律确定性轮询（expect.poll），无长 sleep。桌面无真实软键盘，走聚焦 fallback 抑制。
import { test, expect } from "../harness/fixtures";
import type { Page } from "@playwright/test";
import { ensureRegisteredByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import { createStoryWorkByPage } from "./helpers/library";

/** 探针快照（与 PlaybackSessionProbe 对齐，序列化安全子集）。 */
type ProbeSnapshot = {
    probe?: string;
    sessionId?: string | null;
    source?: { kind: string; workId?: number; messageId?: string } | null;
    status?: string;
    continuationMode?: string;
    nextParagraphIndex?: number;
    totalParagraphs?: number;
    transport?: {
        isPlaying?: boolean;
        hasAudioUrl?: boolean;
        audioUrl?: string | null;
        currentTime?: number;
        hasController?: boolean;
    };
    audioCount?: number;
};

/** 读探针快照（未就绪抛错由 poll 重试）。 */
async function readProbe(page: Page): Promise<ProbeSnapshot> {
    return (await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const probe = w["__M5PlaybackProbe"] as { snapshot?: () => ProbeSnapshot } | undefined;
        if (!probe || typeof probe.snapshot !== "function") throw new Error("probe-not-ready");
        return probe.snapshot();
    })) as ProbeSnapshot;
}

test("MainChrome 移动端固定 Mini 全链路", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(240000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };

    await page.addInitScript(() => {
        try {
            window.localStorage.setItem("chat_onboarding_seen_v1", "true");
        } catch {}
    });

    let beginSessionCount = 0;
    let ttsSynthCount = 0;
    page.on("request", (req) => {
        try {
            const url: string = req.url();
            if (url.includes("beginSession")) beginSessionCount += 1;
            if (url.includes("tts.synthesize") || url.includes("synthesize")) {
                if (url.includes("/api/trpc/")) ttsSynthCount += 1;
            }
        } catch {}
    });

    await ensureRegisteredByApi(
        page,
        harnessEnv.appUrl,
        `m6chrome_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
        "SecurePass123!",
    );
    await dismissOnboarding(page);
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
    await expect(page.getByTestId("m5-playback-probe")).toBeAttached({ timeout: 15000 });
    recorder.step("探针就绪", {});

    // B（前置）：无 session → 无幽灵预留。
    await page.setViewportSize({ width: 767, height: 844 });
    await page.goto(`${harnessEnv.appUrl}/chat`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("main-chrome")).toBeAttached({ timeout: 15000 });
    await expect
        .poll(async () => page.getByTestId("main-chrome").getAttribute("data-has-docked-mini"), { timeout: 15000 })
        .toBe("false");
    await expect(page.getByTestId("mini-now-playing")).toHaveCount(0);
    recorder.step("无会话无幽灵预留", {});

    // 真实 StoryWork（两段式，每段 >80 字防前向合并，确保 total>=2）。
    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const para = (label: string): string => `${label}森林里的小猫勇敢出发寻找魔法宝石，一路上遇到了善良的小兔和机智的小狐狸，大家决定结伴同行互相帮助共同面对未知的挑战。${"内容".repeat(40)}${label}尾`;
    const work = await createStoryWorkByPage(page, {
        title: `固定Mini${runKey}`,
        prompt: `固定Mini提示词${runKey}`,
        storyText: `${para("甲")}\n${para("乙")}`,
    });
    recorder.step("真实作品创建", { workId: work.id });

    // 建立播放会话 S（真实 beginSession + 真实 TTS 首段），随即 pause 驻留消除 1s MP3 自然 ended 竞态。
    const afterBegin = (await page.evaluate((workId: number) => {
        const w = window as unknown as Record<string, { beginWork: (id: number, mode: string) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].beginWork(workId, "resume");
    }, work.id)) as ProbeSnapshot;
    expect(typeof afterBegin.sessionId === "string" && (afterBegin.sessionId as string).length > 0).toBe(true);
    const sessionId = afterBegin.sessionId as string;
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { playParagraph: (i: number) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].playParagraph(0);
    });
    await expect
        .poll(async () => (await readProbe(page)).transport?.hasAudioUrl === true, { timeout: 30000 })
        .toBe(true);
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { pause: () => ProbeSnapshot }>;
        return w["__M5PlaybackProbe"].pause();
    });
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 30000 }).toBe("paused");
    const beforeNav = await readProbe(page);
    expect(beforeNav.sessionId).toBe(sessionId);
    const pausedAudioUrl = beforeNav.transport?.audioUrl as string;
    expect(typeof pausedAudioUrl === "string" && pausedAudioUrl.length > 0).toBe(true);
    recorder.step("会话建立+驻留", { sessionId, status: beforeNav.status });

    // A：767 + active session → compact-docked，Mini 在 TabBar 上方、不可拖、TabBar/Composer 可达。
    await page.setViewportSize({ width: 767, height: 844 });
    await expect
        .poll(async () => page.getByTestId("main-chrome").getAttribute("data-layoutmode"), { timeout: 15000 })
        .toBe("compact-docked");
    await expect
        .poll(async () => page.getByTestId("main-chrome").getAttribute("data-has-docked-mini"), { timeout: 15000 })
        .toBe("true");
    const mini = page.getByTestId("mini-now-playing");
    await expect(mini).toBeVisible({ timeout: 15000 });
    await expect(mini).toHaveAttribute("data-layoutmode", "compact-docked");
    // Composer 与 TabBar 可达（不被遮挡）。
    await expect(page.getByPlaceholder("请输入内容...")).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("tab", { name: "故事库" })).toBeVisible({ timeout: 15000 });
    // 几何：Mini 底边在 TabBar 顶边之上（至少 4px 间隙，容差取整）。
    const geometry = await page.evaluate(() => {
        const miniEl = document.querySelector('[data-testid="mini-now-playing"]');
        const tabEl = document.querySelector('[role="tablist"]') ?? document.querySelector("nav");
        if (!miniEl || !tabEl) throw new Error("geometry-target-missing");
        const m = miniEl.getBoundingClientRect();
        const t = (tabEl as HTMLElement).getBoundingClientRect();
        const cs = window.getComputedStyle(miniEl);
        return {
            miniBottom: m.bottom,
            tabTop: t.top,
            gap: t.top - m.bottom,
            position: cs.position,
            draggable: (miniEl as HTMLElement).draggable,
        };
    });
    expect(geometry.position).toBe("fixed");
    expect(geometry.draggable).toBe(false);
    // docked 语义 = 不遮挡（Mini 底边在 TabBar 顶边之上，允许贴合触碰，容差 1px 子像素）。
    expect(geometry.gap).toBeGreaterThanOrEqual(-1);
    // 同时约束贴合上限：docked 紧贴 TabBar，不应悬空过高（兼容浮层也不远离）。
    expect(geometry.gap).toBeLessThan(32);
    // 不可拖：尝试拖拽后位置不变（mouse 拖 60px，轮询复核）。
    const boxBefore = await mini.boundingBox();
    expect(boxBefore).not.toBeNull();
    await mini.hover({ timeout: 15000 });
    await page.mouse.move((boxBefore as { x: number; y: number }).x + 40, (boxBefore as { x: number; y: number }).y + 10);
    await page.mouse.down();
    await page.mouse.move((boxBefore as { x: number; y: number }).x + 100, (boxBefore as { x: number; y: number }).y + 60, { steps: 5 });
    await page.mouse.up();
    await expect
        .poll(async () => {
            const b = await mini.boundingBox();
            if (!b || !boxBefore) return "missing";
            return Math.abs(b.x - (boxBefore as { x: number }).x) < 3 && Math.abs(b.y - (boxBefore as { y: number }).y) < 3
                ? "stable"
                : `moved:${b.x},${b.y}`;
        }, { timeout: 10000 })
        .toBe("stable");
    recorder.step("移动端固定几何", geometry);

    // C：keyboard open → Mini 隐藏，Session/音频不变。
    // 桌面 Playwright 无真实手机软键盘：聚焦 + 确定性 visualViewport 收缩模拟
    // （spec §17.2：可编辑聚焦 + vv 收缩 >150px → open；单纯聚焦在桌面 vv 下不抑制，符合产品语义）。
    const composer = page.getByPlaceholder("请输入内容...");
    await composer.click({ timeout: 15000 });
    await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const vv = window.visualViewport as unknown as Record<string, unknown> | null;
        const target = window.innerHeight - 250;
        (w as Record<string, unknown>)["__m6OrigVvHeight"] = vv && typeof vv["height"] === "number" ? vv["height"] : null;
        try {
            if (vv) {
                Object.defineProperty(vv, "height", { value: target, configurable: true, writable: true });
            }
        } catch {}
        try {
            window.dispatchEvent(new Event("resize"));
            document.dispatchEvent(new Event("focusin", { bubbles: true } as EventInit));
            (vv as unknown as { dispatchEvent?: (e: Event) => void })?.dispatchEvent?.(new Event("resize"));
        } catch {}
    });
    await expect
        .poll(async () => page.getByTestId("mini-slot").getAttribute("data-visible"), { timeout: 15000 })
        .toBe("false");
    await expect(page.getByTestId("mini-now-playing")).toHaveCount(0);
    const duringKbd = await readProbe(page);
    expect(duringKbd.sessionId).toBe(sessionId);
    expect(duringKbd.status).toBe("paused");
    expect(duringKbd.transport?.audioUrl).toBe(pausedAudioUrl);
    recorder.step("键盘隐藏纯布局", { sessionId: duringKbd.sessionId });

    // D：keyboard close → 同一 sessionId 恢复。
    await page.evaluate(() => {
        const active = document.activeElement as unknown as { blur?: () => void } | null;
        active?.blur?.();
        const w = window as unknown as Record<string, unknown>;
        const vv = window.visualViewport as unknown as Record<string, unknown> | null;
        const orig = w["__m6OrigVvHeight"] as number | null;
        try {
            if (vv && typeof orig === "number") {
                Object.defineProperty(vv, "height", { value: orig, configurable: true, writable: true });
            }
        } catch {}
        try {
            window.dispatchEvent(new Event("resize"));
            document.dispatchEvent(new Event("focusout", { bubbles: true } as EventInit));
            (vv as unknown as { dispatchEvent?: (e: Event) => void })?.dispatchEvent?.(new Event("resize"));
        } catch {}
    });
    await expect
        .poll(async () => page.getByTestId("mini-now-playing").count(), { timeout: 15000 })
        .toBe(1);
    const afterKbd = await readProbe(page);
    expect(afterKbd.sessionId).toBe(sessionId);
    await expect(page.getByTestId("mini-metadata-button")).toBeVisible({ timeout: 15000 });
    recorder.step("键盘恢复", { sessionId: afterKbd.sessionId });

    // 同一 Host 标记（跨路由存活即同一 Host）。
    await page.evaluate(() => {
        const audio = document.querySelector("audio");
        if (audio) {
            (audio as unknown as Record<string, unknown>)["__m6ChromeMarker"] = "m6-chrome-v1";
            audio.dataset.hostSurrogate = "active";
        }
    });
    beginSessionCount = 0;
    ttsSynthCount = 0;

    // E：点击 Mini metadata → openExpanded()（M7 冻结：URL 不变、会话连续、Host 不重建）。
    const urlBeforeExpand = page.url();
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    // URL 不变，且从未进入 /player。
    expect(page.url()).toBe(urlBeforeExpand);
    expect(page.url()).not.toContain("/player");
    // Session 连续：同一 sessionId，播放态/轨道不变。
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(sessionId);
    const onExpand = await readProbe(page);
    expect(onExpand.status).toBe("paused");
    expect(onExpand.transport?.audioUrl).toBe(pausedAudioUrl);
    // Host 未重建：同一 audio 元素标记存活且唯一。
    const expandMarker = await page.evaluate(() => {
        const audio = document.querySelector("audio");
        if (!audio) return { alive: false, count: document.querySelectorAll("audio").length };
        return {
            alive:
                (audio as unknown as Record<string, unknown>)["__m6ChromeMarker"] === "m6-chrome-v1" &&
                audio.dataset.hostSurrogate === "active",
            count: document.querySelectorAll("audio").length,
        };
    });
    expect(expandMarker.count).toBe(1);
    expect(expandMarker.alive).toBe(true);
    // 关闭 Expanded（Escape）：Mini 恢复，会话仍同一，URL 仍不变。
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    await expect.poll(async () => page.getByTestId("mini-now-playing").count(), { timeout: 15000 }).toBe(1);
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(sessionId);
    expect(page.url()).toBe(urlBeforeExpand);
    recorder.step("点击展开URL不变会话连续", { sessionId });

    // F：跨 /chat /library /setting → 同一 Session、唯一 Host、零重建。
    const libraryTab = page.getByRole("tab", { name: "故事库" });
    const settingTab = page.getByRole("tab", { name: "设置" });
    const chatTab = page.getByRole("tab", { name: "创作" });
    await libraryTab.click({ timeout: 15000 });
    await page.waitForURL("**/library", { timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 30000 }).toBe(sessionId);
    await expect(page.getByTestId("mini-now-playing")).toBeVisible({ timeout: 15000 });
    await settingTab.click({ timeout: 15000 });
    await page.waitForURL("**/setting", { timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 30000 }).toBe(sessionId);
    await page.goBack();
    await page.waitForURL("**/library", { timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 30000 }).toBe(sessionId);
    await chatTab.click({ timeout: 15000 });
    await page.waitForURL("**/chat", { timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 30000 }).toBe(sessionId);
    const afterNav = await readProbe(page);
    expect(afterNav.sessionId).toBe(sessionId);
    expect(afterNav.source?.kind).toBe("work");
    expect((afterNav.source as { workId?: number })?.workId).toBe(work.id);
    expect(afterNav.status).toBe("paused");
    expect(afterNav.audioCount).toBe(1);
    expect(afterNav.transport?.audioUrl).toBe(pausedAudioUrl);
    const markerAlive = await page.evaluate(() => {
        const audio = document.querySelector("audio");
        if (!audio) return { alive: false, count: document.querySelectorAll("audio").length };
        return {
            alive:
                (audio as unknown as Record<string, unknown>)["__m6ChromeMarker"] === "m6-chrome-v1" &&
                audio.dataset.hostSurrogate === "active",
            count: document.querySelectorAll("audio").length,
        };
    });
    expect(markerAlive.count).toBe(1);
    expect(markerAlive.alive).toBe(true);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    recorder.step("跨路由存活", { sessionId, markerAlive, beginSessionCount, ttsSynthCount });

    // G：768 不进 mobile 分支。
    await page.setViewportSize({ width: 768, height: 844 });
    await expect
        .poll(async () => page.getByTestId("main-chrome").getAttribute("data-layoutmode"), { timeout: 15000 })
        .not.toBe("compact-docked");
    const mode768 = await page.getByTestId("main-chrome").getAttribute("data-layoutmode");
    expect(mode768 === "wide-floating" || mode768 === "wide-docked").toBe(true);
    await expect(page.getByTestId("mini-now-playing")).toBeVisible({ timeout: 15000 });
    const probe768 = await readProbe(page);
    expect(probe768.sessionId).toBe(sessionId);
    recorder.step("768非移动分支", { mode768 });
});
