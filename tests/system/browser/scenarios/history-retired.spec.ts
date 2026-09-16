//：Prompt/Generation History 前后端退役；创作页不得再暴露任何旧 History 入口，
// 原「清空」按钮文案切换为「新建创作」。
import { test, expect } from "../harness/fixtures";
import { ensureGuestByApi } from "./helpers/auth";
import { captureT2Visual } from "./helpers/visual";

test("创作页不再暴露旧 History 入口", async ({ page, harnessEnv }) => {
    test.setTimeout(120000);

    await ensureGuestByApi(page, harnessEnv.appUrl);

    // 旧 History 触发器与面板（文案/角色）全部消失。
    await expect(page.getByRole("button", { name: "打开历史" })).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "历史类型切换" })).toHaveCount(0);
    await expect(page.getByText("提示词历史", { exact: false })).toHaveCount(0);
    await expect(page.getByText("生成历史", { exact: false })).toHaveCount(0);
    await expect(page.getByText("回放此故事", { exact: false })).toHaveCount(0);
    await expect(page.getByText("用此提示词重新创作", { exact: false })).toHaveCount(0);

    // 新的唯一重置入口文案存在。
    await expect(page.getByRole("button", { name: "新建创作" })).toBeVisible({
        timeout: 30000,
    });
    // 连续创作状态卡（新增）存在，证明创作页已围绕当前集合运行。
    await expect(page.getByTestId("continuous-status-card")).toBeVisible();

    await captureT2Visual(page, "history-retired-desktop");
});

test.describe("移动端视图", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("旧 History 入口移动端同样消失", async ({ page, harnessEnv }) => {
        test.setTimeout(120000);
        await ensureGuestByApi(page, harnessEnv.appUrl);
        await expect(page.getByRole("button", { name: "打开历史" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "新建创作" })).toBeVisible({
            timeout: 30000,
        });
        await captureT2Visual(page, "history-retired-mobile");
    });
});
