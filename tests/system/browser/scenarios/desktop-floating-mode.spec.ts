// case_id: desktop-floating-mode-closure
// journey: smoke-baseline
// M6-04 Desktop Floating Mode & M6 Closure（聚合单场景，spec §18/§19/§49）。
// 1280 + pref true → wide-floating 默认右下、Grip-only drag、clamp、edge snap；
// 越界拖拽仍完全可见；缩窗 re-clamp；pref false → wide-docked（固定 TabBar 上方、Grip 消失、不可拖）；
// 跨 767↔1280 往返同一 Session、drag 不残留；reload 回默认右下（内存态）。
// 慢沙箱一律确定性轮询（expect.poll），无长 sleep；Chromium/WebKit 双跑，不重试。
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

/** 读 Mini 几何（缺失抛错由 poll 重试）。 */
async function readMiniGeometry(page: Page) {
    return (await page.evaluate(() => {
        const miniEl = document.querySelector('[data-testid="mini-now-playing"]');
        if (!miniEl) throw new Error("mini-missing");
        const m = miniEl.getBoundingClientRect();
        const cs = window.getComputedStyle(miniEl);
        return {
            x: m.x,
            y: m.y,
            left: m.left,
            top: m.top,
            right: m.right,
            bottom: m.bottom,
            width: m.width,
            height: m.height,
            position: cs.position,
            widthCss: cs.width,
            dragged: miniEl.getAttribute("data-dragged"),
            layoutmode: miniEl.getAttribute("data-layoutmode"),
            viewportW: window.innerWidth,
            viewportH: window.innerHeight,
        };
    })) as {
        x: number;
        y: number;
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
        position: string;
        widthCss: string;
        dragged: string | null;
        layoutmode: string | null;
        viewportW: number;
        viewportH: number;
    };
}

test("Desktop Floating 拖拽吸附与 M6 收官全链路", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(300000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };

    await page.addInitScript(() => {
        try {
            window.localStorage.setItem("chat_onboarding_seen_v1", "true");
        } catch {}
    });

    await ensureRegisteredByApi(
        page,
        harnessEnv.appUrl,
        `m6float_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
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

    // 真实 StoryWork（两段式，每段 >80 字防前向合并，确保 total>=2）。
    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const para = (label: string): string => `${label}森林里的小猫勇敢出发寻找魔法宝石，一路上遇到了善良的小兔和机智的小狐狸，大家决定结伴同行互相帮助共同面对未知的挑战。${"内容".repeat(40)}${label}尾`;
    const work = await createStoryWorkByPage(page, {
        title: `悬浮收官${runKey}`,
        prompt: `悬浮收官提示词${runKey}`,
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

    // 1) 1280 + pref true（默认）→ wide-floating 默认右下，Grip 可见，未拖拽。
    // goto 触发整页加载（内存 Transport 丢失、水合为 ready），随后重播+暂停恢复可拖拽的驻留态。
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${harnessEnv.appUrl}/chat`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 60000 }).toBe(sessionId);
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
    await expect(page.getByTestId("main-chrome")).toBeAttached({ timeout: 15000 });
    await expect
        .poll(async () => page.getByTestId("main-chrome").getAttribute("data-layoutmode"), { timeout: 15000 })
        .toBe("wide-floating");
    const mini = page.getByTestId("mini-now-playing");
    await expect(mini).toBeVisible({ timeout: 15000 });
    await expect(mini).toHaveAttribute("data-layoutmode", "wide-floating");
    await expect(mini).toHaveAttribute("data-dragged", "false");
    const grip = page.getByTestId("mini-drag-grip");
    await expect(grip).toBeVisible({ timeout: 15000 });
    // floating 不占位（BottomChrome 预留关闭）。
    await expect
        .poll(async () => page.getByTestId("main-chrome").getAttribute("data-has-docked-mini"), { timeout: 15000 })
        .toBe("false");
    // 默认右下几何：position fixed + width 360 附近 + 右贴边 16±6 + 底贴 TabBar+16（容差 24）。
    const defGeo = await readMiniGeometry(page);
    expect(defGeo.position).toBe("fixed");
    expect(defGeo.layoutmode).toBe("wide-floating");
    expect(Math.abs(defGeo.width - 360)).toBeLessThan(24);
    expect(defGeo.viewportW - defGeo.right).toBeGreaterThanOrEqual(8);
    expect(defGeo.viewportW - defGeo.right).toBeLessThan(28);
    expect(defGeo.dragged).toBe("false");
    recorder.step("浮动默认右下", defGeo);

    // 2) Grip 拖拽 → edge snap + clamp：向左大幅拖后释放，贴左或右一边且完全可见。
    const gripBox = await grip.boundingBox();
    expect(gripBox).not.toBeNull();
    const startX = (gripBox as { x: number; y: number; width: number; height: number }).x + (gripBox as { width: number }).width / 2;
    const startY = (gripBox as { y: number; height: number }).y + (gripBox as { height: number }).height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // 向左拖 500px（分步，跟手 clamp），验证拖拽中不出界由终态断言覆盖。
    await page.mouse.move(startX - 500, startY + 40, { steps: 12 });
    await page.mouse.up();
    await expect.poll(async () => (await readMiniGeometry(page)).dragged, { timeout: 15000 }).toBe("true");
    // snap 伴随 200ms 过渡（reduced-motion 外）：轮询等待贴边完成，而非瞬时断言。
    await expect.poll(async () => {
        const g = await readMiniGeometry(page);
        return Math.min(Math.abs(g.left - 16), Math.abs(g.viewportW - g.right - 16));
    }, { timeout: 15000 }).toBeLessThan(8);
    const afterDrag = await readMiniGeometry(page);
    // 完全可见。
    expect(afterDrag.left).toBeGreaterThanOrEqual(-1);
    expect(afterDrag.top).toBeGreaterThanOrEqual(-1);
    expect(afterDrag.right).toBeLessThanOrEqual(afterDrag.viewportW + 1);
    expect(afterDrag.bottom).toBeLessThanOrEqual(afterDrag.viewportH + 1);
    const probeAfterDrag = await readProbe(page);
    expect(probeAfterDrag.sessionId).toBe(sessionId);
    expect(probeAfterDrag.status).toBe("paused");
    recorder.step("拖拽吸附一边", afterDrag);

    // 2b) Playback 按钮不参与 drag：从播放按钮拖 80px，Mini 不移动。
    const playBtn = page.getByTestId("mini-playback-button");
    await expect(playBtn).toBeVisible({ timeout: 15000 });
    const miniBoxBeforeBtnDrag = await readMiniGeometry(page);
    const playBox = await playBtn.boundingBox();
    expect(playBox).not.toBeNull();
    await page.mouse.move((playBox as { x: number; y: number }).x + 10, (playBox as { y: number }).y + 10);
    await page.mouse.down();
    await page.mouse.move((playBox as { x: number }).x + 90, (playBox as { y: number }).y + 60, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const miniBoxAfterBtnDrag = await readMiniGeometry(page);
    expect(Math.abs(miniBoxAfterBtnDrag.left - miniBoxBeforeBtnDrag.left)).toBeLessThan(6);
    expect(Math.abs(miniBoxAfterBtnDrag.top - miniBoxBeforeBtnDrag.top)).toBeLessThan(6);
    recorder.step("播放按钮不触发拖拽", { before: miniBoxBeforeBtnDrag, after: miniBoxAfterBtnDrag });

    // 3) 越界拖拽仍 clamp：往右下视口外拖，释放后仍完全可见且贴右。
    const gripBox2 = await grip.boundingBox();
    expect(gripBox2).not.toBeNull();
    const sx2 = (gripBox2 as { x: number; y: number; width: number; height: number }).x + (gripBox2 as { width: number }).width / 2;
    const sy2 = (gripBox2 as { y: number; height: number }).y + (gripBox2 as { height: number }).height / 2;
    await page.mouse.move(sx2, sy2);
    await page.mouse.down();
    await page.mouse.move(sx2 + 800, sy2 + 600, { steps: 12 });
    await page.mouse.up();
    await expect.poll(async () => {
        const g = await readMiniGeometry(page);
        return g.right <= g.viewportW + 1 && g.bottom <= g.viewportH + 1 && g.left >= -1 && g.top >= -1 ? "inside" : "outside";
    }, { timeout: 15000 }).toBe("inside");
    // 越界后 snap 贴右同样伴随过渡：轮询等待。
    await expect.poll(async () => {
        const g = await readMiniGeometry(page);
        return Math.abs(g.viewportW - g.right - 16);
    }, { timeout: 15000 }).toBeLessThan(8);
    const clamped = await readMiniGeometry(page);
    const probeClamped = await readProbe(page);
    expect(probeClamped.sessionId).toBe(sessionId);
    recorder.step("越界 clamp 贴右", clamped);

    // 4) 缩窗 re-clamp：1280→800，仍完全可见，同一 Session。
    await page.setViewportSize({ width: 800, height: 600 });
    await expect.poll(async () => {
        const g = await readMiniGeometry(page);
        return g.viewportW === 800 && g.right <= g.viewportW + 1 && g.left >= -1 ? "ok" : `bad:${g.right},${g.viewportW}`;
    }, { timeout: 15000 }).toBe("ok");
    const afterShrink = await readMiniGeometry(page);
    expect(afterShrink.viewportW).toBe(800);
    const probeShrink = await readProbe(page);
    expect(probeShrink.sessionId).toBe(sessionId);
    // 回 1280：仍合法可见（恢复或 re-clamp，不残留非法坐标）。
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(async () => {
        const g = await readMiniGeometry(page);
        return g.viewportW === 1280 && g.right <= g.viewportW + 1 && g.left >= -1 ? "ok" : "bad";
    }, { timeout: 15000 }).toBe("ok");
    recorder.step("缩窗回 clamp", { afterShrink });

    // 5) pref false → wide-docked：经设置页关闭，固定 TabBar 上方、Grip 消失、不可拖、重新预留。
    await page.getByRole("tab", { name: "设置" }).click({ timeout: 15000 });
    await page.waitForURL("**/setting", { timeout: 15000 });
    const floatSwitch = page.getByLabel("桌面悬浮播放开关");
    await expect(floatSwitch).toBeVisible({ timeout: 15000 });
    // 默认 true：DOM click 切换（规避 track 子层指针拦截；以 layoutmode 为真 oracle）。
    await floatSwitch.evaluate((el) => (el as HTMLElement).click());
    await expect
        .poll(async () => page.getByTestId("main-chrome").getAttribute("data-layoutmode"), { timeout: 15000 })
        .toBe("wide-docked");
    await expect(page.getByTestId("mini-now-playing")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("mini-drag-grip")).toHaveCount(0);
    await expect
        .poll(async () => page.getByTestId("main-chrome").getAttribute("data-has-docked-mini"), { timeout: 15000 })
        .toBe("true");
    // docked 几何：在 TabBar 上方（gap -1..32，与移动端同口径）。
    const dockedGeo = await page.evaluate(() => {
        const miniEl = document.querySelector('[data-testid="mini-now-playing"]');
        const tabEl = document.querySelector('[role="tablist"]') ?? document.querySelector("nav");
        if (!miniEl || !tabEl) throw new Error("geometry-target-missing");
        const m = miniEl.getBoundingClientRect();
        const t = (tabEl as HTMLElement).getBoundingClientRect();
        const cs = window.getComputedStyle(miniEl);
        return { miniBottom: m.bottom, tabTop: t.top, gap: t.top - m.bottom, position: cs.position };
    });
    expect(dockedGeo.position).toBe("fixed");
    expect(dockedGeo.gap).toBeGreaterThanOrEqual(-1);
    expect(dockedGeo.gap).toBeLessThan(32);
    // 不可拖：从 Mini 中心拖 80px，位置稳定。
    const dockedMini = page.getByTestId("mini-now-playing");
    const dockBoxBefore = await dockedMini.boundingBox();
    expect(dockBoxBefore).not.toBeNull();
    await dockedMini.hover({ timeout: 15000 });
    await page.mouse.move((dockBoxBefore as { x: number; y: number }).x + 40, (dockBoxBefore as { x: number; y: number }).y + 10);
    await page.mouse.down();
    await page.mouse.move((dockBoxBefore as { x: number }).x + 120, (dockBoxBefore as { y: number }).y + 60, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => {
        const b = await dockedMini.boundingBox();
        if (!b || !dockBoxBefore) return "missing";
        return Math.abs(b.x - (dockBoxBefore as { x: number }).x) < 4 && Math.abs(b.y - (dockBoxBefore as { y: number }).y) < 4 ? "stable" : "moved";
    }, { timeout: 10000 }).toBe("stable");
    const probeDocked = await readProbe(page);
    expect(probeDocked.sessionId).toBe(sessionId);
    recorder.step("宽屏关闭转 docked", { dockedGeo });

    // 6) 跨 768 往返同一 Session：1280 wide-docked → 767 compact → 1280 wide-docked。
    await page.setViewportSize({ width: 767, height: 844 });
    await expect
        .poll(async () => page.getByTestId("main-chrome").getAttribute("data-layoutmode"), { timeout: 15000 })
        .toBe("compact-docked");
    await expect(page.getByTestId("mini-now-playing")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("mini-drag-grip")).toHaveCount(0);
    expect((await readProbe(page)).sessionId).toBe(sessionId);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect
        .poll(async () => page.getByTestId("main-chrome").getAttribute("data-layoutmode"), { timeout: 15000 })
        .toBe("wide-docked");
    expect((await readProbe(page)).sessionId).toBe(sessionId);
    const backGeo = await readMiniGeometry(page);
    expect(backGeo.left).toBeGreaterThanOrEqual(-1);
    expect(backGeo.right).toBeLessThanOrEqual(backGeo.viewportW + 1);
    recorder.step("跨 768 往返同一会话", { backGeo });

    // 7) 重新开启 floating，再 reload 回默认右下（内存态，不跨刷新持久化）。
    await page.getByRole("tab", { name: "设置" }).click({ timeout: 15000 }).catch(() => {});
    // 已在 setting：DOM click 再次切换回 true（以 layoutmode 为真 oracle）。
    const floatSwitch2 = page.getByLabel("桌面悬浮播放开关");
    await expect(floatSwitch2).toBeVisible({ timeout: 15000 });
    await floatSwitch2.evaluate((el) => (el as HTMLElement).click());
    await expect
        .poll(async () => page.getByTestId("main-chrome").getAttribute("data-layoutmode"), { timeout: 15000 })
        .toBe("wide-floating");
    expect((await readProbe(page)).sessionId).toBe(sessionId);
    // 等待 500ms 防抖回写落库后再 reload（否则刷新读到旧偏好 wide-docked）。
    await expect.poll(async () => page.evaluate(async () => {
        try {
            const res = await fetch(
                "/api/trpc/config.getMine?batch=1&input=" + encodeURIComponent(JSON.stringify({ "0": { json: null } })),
            );
            if (!res.ok) return "http-" + res.status;
            const body = (await res.json()) as Array<{
                result?: { data?: { json?: { desktopFloatingPlayerEnabled?: boolean } } };
            }>;
            return body?.[0]?.result?.data?.json?.desktopFloatingPlayerEnabled === true
                ? "persisted-true"
                : "pending";
        } catch {
            return "error";
        }
    }), { timeout: 15000 }).toBe("persisted-true");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await dismissOnboarding(page);
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
    await expect(page.getByTestId("m5-playback-probe")).toBeAttached({ timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 60000 }).toBe(sessionId);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect
        .poll(async () => page.getByTestId("main-chrome").getAttribute("data-layoutmode"), { timeout: 30000 })
        .toBe("wide-floating");
    await expect(page.getByTestId("mini-now-playing")).toBeVisible({ timeout: 15000 });
    // reload 后回默认：data-dragged=false，且右贴边 16±8。
    await expect.poll(async () => (await readMiniGeometry(page)).dragged, { timeout: 15000 }).toBe("false");
    const reloaded = await readMiniGeometry(page);
    expect(reloaded.viewportW - reloaded.right).toBeGreaterThanOrEqual(8);
    expect(reloaded.viewportW - reloaded.right).toBeLessThan(28);
    const probeReloaded = await readProbe(page);
    expect(probeReloaded.sessionId).toBe(sessionId);
    expect(probeReloaded.source?.kind).toBe("work");
    recorder.step("刷新回默认右下", { reloaded });
});
