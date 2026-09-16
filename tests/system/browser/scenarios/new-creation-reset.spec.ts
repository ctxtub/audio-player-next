//：创作页「新建创作」是唯一强重置入口（原「清空」）。
// 空会话点击后 Chat 归 idle、active Conversation identity 切换，且连续创作恢复默认开启。
import { test, expect } from "../harness/fixtures";
import { ensureGuestByApi } from "./helpers/auth";

test("新建创作强重置并恢复连续创作默认开启", async ({ page, harnessEnv }) => {
    test.setTimeout(120000);
    // 防御：万一进入需要确认的分支，接受原生 confirm 不阻塞用例。
    page.on("dialog", (dialog) => {
        void dialog.accept();
    });

    await ensureGuestByApi(page, harnessEnv.appUrl);

    const clearButton = page.getByRole("button", { name: "新建创作" });
    await expect(clearButton).toBeVisible({ timeout: 30000 });

    const switchEl = page.getByTestId("continuous-switch");
    await expect(switchEl).toHaveAttribute("aria-checked", "true");

    // 先关闭连续创作，模拟上一会话的显式选择。
    await switchEl.click();
    await expect(switchEl).toHaveAttribute("aria-checked", "false");

    // 新建创作：空会话无需确认，直接强重置 + 新建 active Conversation。
    await clearButton.click();

    // 强重置后必须恢复默认开启与空闲态。
    await expect(switchEl).toHaveAttribute("aria-checked", "true", { timeout: 30000 });
    await expect(page.getByTestId("continuous-status-card")).toContainText("连续创作已开启");
    await expect(page.getByTestId("continuous-remaining-budget")).toContainText("剩余");

    // 旧 History 入口不得因新建创作而复现。
    await expect(page.getByRole("button", { name: "打开历史" })).toHaveCount(0);
});
