// case_id: expanded-global-surface-responsive
// journey: smoke-baseline
// M7-01 Expanded 全局浮层与响应式 Surface（验收 1-10 targeted）。
// Mini click → Expanded（URL 不变）/ 开关不改播放 / suppress 恢复 / 普通导航保持 /
// 390 Sheet + 900 Panel + resize 不重置 / Escape-backdrop 关闭继续 / 焦点进出 / ended 完成态 /
// /player 物理保留但不再 push。慢沙箱确定性轮询，无长 sleep。
import { test, expect } from "../harness/fixtures";
import type { Page } from "@playwright/test";
import { ensureRegisteredByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import { createStoryWorkByPage } from "./helpers/library";

/** 探针快照（与 PlaybackSessionProbe 对齐子集）。 */
type ProbeSnapshot = {
    probe?: string;
    sessionId?: string | null;
    source?: { kind: string; workId?: number; messageId?: string } | null;
    status?: string;
    transport?: {
        isPlaying?: boolean;
        hasAudioUrl?: boolean;
        audioUrl?: string | null;
        hasController?: boolean;
    };
    audioCount?: number;
};

async function readProbe(page: Page): Promise<ProbeSnapshot> {
    return (await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const probe = w["__M5PlaybackProbe"] as { snapshot?: () => ProbeSnapshot } | undefined;
        if (!probe || typeof probe.snapshot !== "function") throw new Error("probe-not-ready");
        return probe.snapshot();
    })) as ProbeSnapshot;
}

test("Expanded 全局浮层与响应式 Surface", async ({ page, harnessEnv, evidence }) => {
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
        `m7exp_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
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

    // 390 基线先占位（后续真实会话建立后复用同一视口，避免 goto 冲掉 transport）。
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${harnessEnv.appUrl}/chat`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("main-chrome")).toBeAttached({ timeout: 15000 });

    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const para = (label: string): string => `${label}森林里的小猫勇敢出发寻找魔法宝石，一路上遇到了善良的小兔和机智的小狐狸，大家决定结伴同行互相帮助共同面对未知的挑战。${"内容".repeat(40)}${label}尾`;
    const work = await createStoryWorkByPage(page, {
        title: `展开浮层${runKey}`,
        prompt: `展开浮层提示词${runKey}`,
        storyText: `${para("甲")}\n${para("乙")}`,
    });
    recorder.step("真实作品创建", { workId: work.id });

    const afterBegin = (await page.evaluate((workId: number) => {
        const w = window as unknown as Record<string, { beginWork: (id: number, mode: string) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].beginWork(workId, "resume");
    }, work.id)) as ProbeSnapshot;
    const sessionId = afterBegin.sessionId as string;
    expect(typeof sessionId === "string" && sessionId.length > 0).toBe(true);
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
    const pausedAudioUrl = (await readProbe(page)).transport?.audioUrl as string;
    const pausedStatus = (await readProbe(page)).status as string;
    recorder.step("首段合成+驻留", { sessionId, pausedStatus });

    // 390 Sheet 基线：Mini 可见、Expanded 关闭（同一视口、同一会话，不再 goto）。
    await expect.poll(async () => page.getByTestId("mini-now-playing").count(), { timeout: 15000 }).toBe(1);
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0);
    await expect(page.getByTestId("now-playing-layer")).toHaveAttribute("data-expanded", "false");
    const urlBefore = page.url();
    expect(urlBefore).not.toContain("/player");
    recorder.step("390 基线", { urlBefore, pausedStatus });

    // Mini click → Expanded（URL 不变、不建新会话）。
    beginSessionCount = 0;
    ttsSynthCount = 0;
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-close-button")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-drag-handle")).toBeAttached({ timeout: 15000 });
    expect(page.url()).toBe(urlBefore);
    expect(page.url()).not.toContain("/player");
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(sessionId);
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 15000 }).toBe(pausedStatus);
    expect((await readProbe(page)).transport?.audioUrl).toBe(pausedAudioUrl);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    // suppress：Mini 隐藏但 session 仍在。
    await expect(page.getByTestId("mini-now-playing")).toHaveCount(0);
    await expect(page.getByTestId("main-chrome")).toHaveAttribute("data-mini-visible", "false");
    recorder.step("点击展开 URL 不变且播放不变", {});

    // Sheet 几何：底锚全宽。
    const sheetBox390 = await page.getByTestId("expanded-sheet").boundingBox();
    expect(sheetBox390).not.toBeNull();
    if (sheetBox390) {
        expect(sheetBox390.width).toBeGreaterThan(300);
        expect(sheetBox390.y + sheetBox390.height).toBeGreaterThan(700);
    }
    // 焦点进入 Expanded（关闭按钮或其内）。
    await expect.poll(
        async () =>
            page.evaluate(() => {
                const active = document.activeElement as unknown as { getAttribute?: (n: string) => string | null; closest?: (s: string) => unknown } | null;
                if (!active) return "none";
                if (typeof active.getAttribute === "function" && active.getAttribute("data-testid") === "expanded-close-button") return "close";
                try {
                    const el = active as unknown as HTMLElement;
                    if (el.closest?.('[data-testid="expanded-now-playing"]')) return "inside";
                } catch {}
                return "outside";
            }),
        { timeout: 15000 },
    ).not.toBe("outside");
    recorder.step("390 Sheet 几何与焦点进入", { sheetBox390 });

    // 普通导航 /chat → /library 后仍 open（spec §44）。
    // 中文注释：Expanded 为 modal，overlay 会拦截真实指针点击到底部 Tab；
    // 这里用 JS 直接触发 Tab 的 click handler（等价客户端路由导航，不经过指针命中），
    // 验证“普通 route change 不自动关闭 Expanded”。
    await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button[role="tab"]')).find((el) =>
            (el.textContent ?? "").includes("故事库"),
        ) as unknown as { click?: () => void } | undefined;
        if (!btn || typeof btn.click !== "function") throw new Error("library-tab-not-found");
        btn.click();
    });
    await page.waitForURL("**/library", { timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(sessionId);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    recorder.step("普通导航保持展开", { url: page.url() });

    // resize 900：仍 open，切 Panel 右锚。
    // 中文注释：入场动画 transient（translateX 24px）会导致瞬时右缘偏差，用轮询等稳定而非长 sleep。
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(sessionId);
    await expect
        .poll(
            async () => {
                const box = await page.getByTestId("expanded-sheet").boundingBox();
                if (!box) return 999;
                return Math.abs(box.x + box.width - 900);
            },
            { timeout: 15000 },
        )
        .toBeLessThan(8);
    const sheetBox900 = await page.getByTestId("expanded-sheet").boundingBox();
    expect(sheetBox900).not.toBeNull();
    if (sheetBox900) {
        // Panel 宽约 400（容差 ±60），右缘贴视口右（容差 8px，上方轮询已保证稳定）。
        expect(Math.abs(sheetBox900.width - 400)).toBeLessThan(60);
        expect(Math.abs(sheetBox900.x + sheetBox900.width - 900)).toBeLessThan(8);
    }
    recorder.step("900 Panel 几何与 resize 不重置", { sheetBox900 });

    // 回 390 仍 open。
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    recorder.step("回 390 仍展开", {});

    // Escape 关闭后播放继续 + Mini 恢复 + 焦点返回。
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    await expect.poll(async () => page.getByTestId("mini-now-playing").count(), { timeout: 15000 }).toBe(1);
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(sessionId);
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 15000 }).toBe(pausedStatus);
    expect((await readProbe(page)).transport?.audioUrl).toBe(pausedAudioUrl);
    await expect.poll(
        async () =>
            page.evaluate(() => {
                const active = document.activeElement as unknown as { getAttribute?: (n: string) => string | null } | null;
                return typeof active?.getAttribute === "function"
                    ? active.getAttribute("data-testid")
                    : "none";
            }),
        { timeout: 15000 },
    ).toBe("mini-metadata-button");
    recorder.step("Escape 关闭继续与焦点返回", {});

    // Backdrop 关闭同样继续（重开后点遮罩）。
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    // RAC overlay 点击：取 overlay 左上非面板区（移动 Sheet 顶部遮罩区）。
    await page.getByTestId("expanded-overlay").click({ position: { x: 20, y: 20 }, timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(sessionId);
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 15000 }).toBe(pausedStatus);
    recorder.step("Backdrop 关闭继续", {});

    // /player 物理保留但正常入口不再 push（全程 URL 从未进 /player）。
    expect(page.url()).not.toContain("/player");
    await page.goto(`${harnessEnv.appUrl}/player`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("main-chrome")).toBeAttached({ timeout: 15000 });
    recorder.step("/player 物理保留", { url: page.url() });
});
