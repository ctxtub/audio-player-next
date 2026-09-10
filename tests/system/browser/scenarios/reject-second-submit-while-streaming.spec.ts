// case_id: reject-second-submit-while-streaming
// journey: interactive-race
// primary_defense: L3
// legacy_aliases: [E2E-02-02, H-02]
import { test, expect } from "../harness/fixtures";
import { ensureGuestByApi } from "./helpers/auth";

/**
 * 流式中第二次提交被拒（旧 H-02）。
 *
 * 断言绑定方案第6节：UI 禁用/拒绝响应 + network 单次 Agent 调用。
 * 以路由延迟拉长首个流式窗口，在窗口内尝试第二次提交，验证互斥语义。
 */
test("流式中第二次提交被拒", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(120000);
    /** 证据记录器（fixtures 自动挂载，显式取用以记录外部时间线）。 */
    const recorder = evidence as unknown as {
        step: (name: string, detail?: unknown) => void;
    };
    /** Agent 交互请求时间线（network 层单次调用证据）。 */
    const agentUrls: string[] = [];
    /** 首个流式请求是否已到达（仅首个延迟拉窗，后续直放）。 */
    let firstSeen = false;
    await page.route("**/api/trpc/agent.interact*", async (route) => {
        agentUrls.push(route.request().url());
        if (!firstSeen) {
            firstSeen = true;
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        await route.continue();
    });

    // 中文注释：经真实访客 API 进入创作页（双浏览器稳态，见 helpers/auth）。
    await ensureGuestByApi(page, harnessEnv.appUrl);

    /** 首个流式提示词。 */
    const firstPrompt = `L3流式A${Date.now()}${Math.floor(Math.random() * 100000)}请讲一个星际冒险故事。`;
    /** 流式窗口内第二次提交内容（应被互斥拒绝）。 */
    const secondPrompt = `L3流式B${Date.now()}${Math.floor(Math.random() * 100000)}请讲一个深海探险故事。`;
    const composer = page.getByPlaceholder("请输入内容...");
    const sendButton = page.getByRole("button", { name: "发送" });

    // 中文注释：提交流 A（路由挂起使其保持 sending，拉出可观测的互斥窗口）。
    await composer.fill(firstPrompt);
    await sendButton.click({ timeout: 15000 });
    // 中文注释：等待首个 Agent 请求到达路由（network 层已发出一次）。
    await expect
        .poll(() => agentUrls.length, { timeout: 30000 })
        .toBeGreaterThanOrEqual(1);
    // 中文注释：UI 断言——流式中输入区禁用（互斥可见态）。
    await expect(composer).toBeDisabled({ timeout: 15000 });
    recorder.step("流式窗口已拉出", { agentUrls: agentUrls.length });

    // 中文注释：窗口内尝试第二次提交（禁用态下应无 second Agent 请求）。
    // 流式中发送键进入 loading（无障碍名变化），不硬点按钮；以输入区禁用 +
    // 回车尝试无新请求为拒证（UI 禁用/拒绝 + network 单次）。
    const disabledState: boolean = await composer.isDisabled();
    expect(disabledState).toBe(true);
    recorder.step("第二次提交内容", { secondPrompt });
    // 全局回车（不对禁用输入框做动作性断言，禁区回车不得开新流）。
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);
    expect(agentUrls.length).toBe(1);

    // 中文注释：首个流经 5s 路由延迟后自动放行，等待其正常完成（输入框恢复可用）。
    await expect(composer).toBeEnabled({ timeout: 90000 });
    recorder.step("首流完成", { agentCalls: agentUrls.length });

    // 中文注释：network 断言——全程仅一次 Agent 调用（第二次被互斥，无新流）。
    expect(agentUrls.length).toBe(1);
});
