import type { Page } from "@playwright/test";

/**
 *  场景访客登录助手（任务13 第二段）。
 *
 * 经由真实 /auth 页点击访客入口进入 /chat，不自造 cookie、不碰生产端口。
 */

/**
 * 经真实认证页进入访客模式并落到创作页。
 * @param page Playwright 页面
 * @param appUrl harness 被测地址
 */
export async function enterGuestChat(page: Page, appUrl: string): Promise<void> {
    await page.goto(appUrl, { waitUntil: "networkidle", timeout: 60000 });
    const guestButton = page.getByRole("button", { name: "以访客身份继续使用" });
    const onAuth = page.url().includes("/auth");
    if (onAuth) {
        await guestButton.click({ timeout: 15000 });
    } else {
        const count: number = await guestButton.count();
        if (count > 0) {
            await guestButton.first().click({ timeout: 15000 });
        }
    }
    await page.waitForURL("**/chat", { timeout: 30000 });
    await dismissOnboarding(page);
}

/**
 * 关闭创作页新手引导弹窗（全新 context 首访必弹，不关则挡住输入框）。
 * @param page Playwright 页面
 */
export async function dismissOnboarding(page: Page): Promise<void> {
    const startButton = page.getByRole("button", { name: "开始体验" });
    // 创作页先渲染主体，配置水合后才可能挂载引导；不能用瞬时 count，
    // 否则 helper 返回后遮罩才出现并拦截第一个真实用户动作。
    const appeared = await startButton
        .first()
        .waitFor({ state: "visible", timeout: 15000 })
        .then(() => true, () => false);
    if (!appeared) return;
    await startButton.first().click();
    await startButton.first().waitFor({ state: "hidden", timeout: 10000 });
}
