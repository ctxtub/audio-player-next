// case_id: continuous-creation-default-on
// journey: story-collection-continuous
// legacy_aliases: [E2E-10-05]
// M9-C1 T2：进入创作页连续创作默认开启；状态卡文案、开关 aria-checked 与剩余预算
// 全部只读 continuousCreationStore（薄封装纯状态机），无手动干预。
// 同时产出桌面 + 移动端视觉验收截图（T2/visual）。
import { test, expect } from "../harness/fixtures";
import { ensureGuestByApi } from "./helpers/auth";
import { captureT2Visual } from "./helpers/visual";

test("连续创作默认开启且状态卡与开关同源", async ({ page, harnessEnv }) => {
    test.setTimeout(120000);

    await ensureGuestByApi(page, harnessEnv.appUrl);

    const switchEl = page.getByTestId("continuous-switch");
    await expect(switchEl).toBeVisible({ timeout: 30000 });
    await expect(switchEl).toHaveAttribute("aria-checked", "true");

    const statusCard = page.getByTestId("continuous-status-card");
    await expect(statusCard).toContainText("连续创作已开启");
    await expect(page.getByTestId("continuous-collection-title")).toContainText("新作品集");
    await expect(page.getByTestId("continuous-remaining-budget")).toContainText("剩余");

    await captureT2Visual(page, "continuous-creation-desktop");

    // 关闭：状态与开关同步为 disabled。
    await switchEl.click();
    await expect(switchEl).toHaveAttribute("aria-checked", "false");
    await expect(statusCard).toContainText("连续创作已关闭");

    // 重新开启：恢复 enabled_idle。
    await switchEl.click();
    await expect(switchEl).toHaveAttribute("aria-checked", "true");
    await expect(statusCard).toContainText("连续创作已开启");

    await captureT2Visual(page, "continuous-creation-desktop-enabled");
});

test.describe("移动端视图", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("连续创作状态卡移动端可达", async ({ page, harnessEnv }) => {
        test.setTimeout(120000);
        await ensureGuestByApi(page, harnessEnv.appUrl);

        const switchEl = page.getByTestId("continuous-switch");
        await expect(switchEl).toBeVisible({ timeout: 30000 });
        await expect(switchEl).toHaveAttribute("aria-checked", "true");
        await expect(page.getByTestId("continuous-status-card")).toContainText("连续创作已开启");

        await captureT2Visual(page, "continuous-creation-mobile");
    });
});
