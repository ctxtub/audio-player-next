// case_id: main-navigation-route-journey
// journey: smoke-baseline
// legacy_aliases: [E2E-01-09]
import { test, expect } from "../harness/fixtures";
import { ensureGuestByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import { createStoryWorkByPage } from "./helpers/library";

/**
 * 主导航路由契约与页面旅程（E2E-01-09，L3 产品覆盖层真场景）。
 *
 * 覆盖矩阵：
 * 1. 完整 Route/Navigation Journey：
 *    - / → 自动重定向到 /chat
 *    - /chat → 点击主导航"故事库" → /library
 *    - /library → 导航至 /library/{真实id}（真实创建有效正整数 id）→ Browser Back → /library
 *    - /library → 点击"设置" → /setting → Browser Back → /library
 * 2. Compatibility Journey：
 *    - /player 直接进入 → Legacy Player 渲染 → 故事库 Tab 保持 selected (compatibility active alias)
 *    - 在 /player 点击"故事库" → 导航至 /library → Browser Back → /player
 * 3. 最小 Global Layout regression：
 *    - /chat → /library → /setting 切换中，AudioControllerHost 常驻且生命周期保持连续（未被销毁或移出 shared layout）
 * 4. 显式前置处理新手引导弹窗（chat_onboarding_seen_v1），确保无偶发遮挡。
 */
test("主导航路由契约与页面旅程", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(120000);

    const recorder = evidence as unknown as {
        step: (name: string, detail?: unknown) => void;
    };

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => {
        if (msg.type() === "error") {
            const text = msg.text().slice(0, 300);
            // WebKit 在跨路由跳转时可能因预载连接被中断输出 Next.js 内部降级日志，排除该平台非业务错误
            if (text.includes("Failed to fetch RSC payload") || text.includes("Falling back to browser navigation")) {
                return;
            }
            consoleErrors.push(text);
        }
    });
    page.on("pageerror", (err) => {
        pageErrors.push(String(err).slice(0, 300));
    });

    // 1. Onboarding 处理（必须）：显式预置 localStorage 标记，消除首次访问引导弹窗对导航点击的偶发遮挡
    await page.addInitScript(() => {
        try {
            window.localStorage.setItem("chat_onboarding_seen_v1", "true");
        } catch {}
    });

    // 经真实访客 API 写入身份 cookie（双浏览器稳态通道）并进入首屏
    await ensureGuestByApi(page, harnessEnv.appUrl);
    await dismissOnboarding(page);

    // 2. 锁定根路由行为：GET / → /chat
    await page.goto(`${harnessEnv.appUrl}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForURL("**/chat", { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe("/chat");
    recorder.step("根路径重定向", page.url());

    // 校验底部主导航 TabBar 初始激活态
    const chatTab = page.getByRole("tab", { name: "创作" });
    const libraryTab = page.getByRole("tab", { name: "故事库" });
    const settingTab = page.getByRole("tab", { name: "设置" });

    await expect(chatTab).toBeVisible({ timeout: 15000 });
    await expect(libraryTab).toBeVisible({ timeout: 15000 });
    await expect(settingTab).toBeVisible({ timeout: 15000 });

    await expect(chatTab).toHaveAttribute("aria-selected", "true");
    await expect(libraryTab).toHaveAttribute("aria-selected", "false");
    await expect(settingTab).toHaveAttribute("aria-selected", "false");
    recorder.step("创作页Tab初始激活", { chat: true, library: false, setting: false });

    // 3. Global Layout 锚定：记录 AudioControllerHost 稳定 observable surrogate
    await expect(page.locator("audio")).toBeAttached({ timeout: 15000 });
    await page.evaluate(() => {
        const audio = document.querySelector("audio");
        if (audio) {
            (audio as unknown as Record<string, unknown>).__audioHostMarker = "audio-host-layout-intact-v1";
            audio.dataset.hostSurrogate = "active";
        }
    });
    recorder.step("AudioControllerHost宿主标记", "audio-host-layout-intact-v1");

    // 4. /chat → 点击"故事库" → /library
    await libraryTab.click({ timeout: 15000 });
    await page.waitForURL("**/library", { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe("/library");

    // 故事库 Tab 变为选中态，故事库 Shell 渲染
    await expect(libraryTab).toHaveAttribute("aria-selected", "true");
    await expect(chatTab).toHaveAttribute("aria-selected", "false");
    await expect(settingTab).toHaveAttribute("aria-selected", "false");
    await expect(page.getByTestId("library-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("heading", { name: "故事库", level: 1 })).toBeVisible({ timeout: 15000 });
    recorder.step("切至故事库主页", page.url());

    // 验证 AudioControllerHost 未因新增 /library route 被移出 shared layout
    const isHostIntactOnLibrary = await page.evaluate(() => {
        const audio = document.querySelector("audio");
        return (
            audio?.dataset.hostSurrogate === "active" &&
            (audio as unknown as Record<string, unknown>).__audioHostMarker === "audio-host-layout-intact-v1"
        );
    });
    expect(isHostIntactOnLibrary).toBe(true);
    recorder.step("故事库主页宿主状态留存", { intact: isHostIntactOnLibrary });

    // 5. /library → 点击"设置" → /setting
    await settingTab.click({ timeout: 15000 });
    await page.waitForURL("**/setting", { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe("/setting");

    await expect(settingTab).toHaveAttribute("aria-selected", "true");
    await expect(libraryTab).toHaveAttribute("aria-selected", "false");
    await expect(chatTab).toHaveAttribute("aria-selected", "false");
    recorder.step("切至设置页", page.url());

    // 验证 AudioControllerHost 在 /chat → /library → /setting 跨路由切换中持续在 shared layout 留存
    const isHostIntactOnSetting = await page.evaluate(() => {
        const audio = document.querySelector("audio");
        return (
            audio?.dataset.hostSurrogate === "active" &&
            (audio as unknown as Record<string, unknown>).__audioHostMarker === "audio-host-layout-intact-v1"
        );
    });
    expect(isHostIntactOnSetting).toBe(true);
    recorder.step("设置页宿主状态留存", { intact: isHostIntactOnSetting });

    // 6. 从 /setting 执行 Browser Back → 回到 /library
    await page.goBack();
    await page.waitForURL("**/library", { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe("/library");
    await expect(libraryTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("library-page")).toBeVisible({ timeout: 15000 });
    recorder.step("从设置页回退故事库主页", page.url());

    // 创建真实 Subject-owned 故事作品获取真实 ID（彻底清除写死 /library/1 历史债）
    const createdWork = await createStoryWorkByPage(page, {
        title: "主导航验证故事",
        prompt: "测试主导航详情跳转提示词",
        storyText: "这是主导航详情跳转测试故事正文内容...",
    });

    // 7. /library → 访问真实 ID 的故事详情页 /library/{id}
    await page.goto(`${harnessEnv.appUrl}/library/${createdWork.id}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    expect(new URL(page.url()).pathname).toBe(`/library/${createdWork.id}`);
    await expect(libraryTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("story-detail-container")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("story-detail-title")).toHaveText(createdWork.title);
    recorder.step("进入故事详情页", page.url());

    // 8. 从 /library/{id} 执行 Browser Back → 回到 /library
    await page.goBack();
    await page.waitForURL("**/library", { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe("/library");
    await expect(libraryTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("library-page")).toBeVisible({ timeout: 15000 });
    recorder.step("从故事详情回退故事库主页", page.url());

    // 9. Compatibility journey：直接进入 /player
    await page.goto(`${harnessEnv.appUrl}/player`, { waitUntil: "domcontentloaded", timeout: 30000 });
    expect(new URL(page.url()).pathname).toBe("/player");

    // 验证 Legacy Player 核心稳定地标完整呈现
    await expect(page.getByRole("slider", { name: "播放进度" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "播放速度" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "从头重播" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("tablist", { name: "历史类型切换" })).toBeVisible({ timeout: 15000 });

    // 故事库 Tab 保持 selected (compatibility active alias)
    await expect(libraryTab).toHaveAttribute("aria-selected", "true");
    await expect(chatTab).toHaveAttribute("aria-selected", "false");
    await expect(settingTab).toHaveAttribute("aria-selected", "false");
    recorder.step("直接访问/player兼容器", page.url());

    // 10. 在 /player 页面点击主导航「故事库」Tab → 切换至 /library
    await libraryTab.click({ timeout: 15000 });
    await page.waitForURL("**/library", { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe("/library");
    await expect(libraryTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("library-page")).toBeVisible({ timeout: 15000 });
    recorder.step("从/player点击故事库Tab切换", page.url());

    // 11. 执行 Browser Back → 回到 /player
    await page.goBack();
    await page.waitForURL("**/player", { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe("/player");
    await expect(page.getByRole("slider", { name: "播放进度" })).toBeVisible({ timeout: 15000 });
    await expect(libraryTab).toHaveAttribute("aria-selected", "true");
    recorder.step("回退到/player兼容器", page.url());

    // 12. 控制台零报错断言（终态无未捕获异常）
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    recorder.step("console与pageerror零错", { consoleErrors: 0, pageErrors: 0 });
});
