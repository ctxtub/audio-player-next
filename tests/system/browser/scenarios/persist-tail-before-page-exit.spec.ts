// case_id: persist-tail-before-page-exit
// journey: cloud-storage
// primary_defense: L3
// legacy_aliases: [E2E-04-02, H-16]
import { test, expect } from "../harness/fixtures";
import { ensureGuestByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import { countTableRows, guestChatContains, resolveIsolationDbPath } from "./helpers/db";

/**
 * 页面退出前尾部持久化送达（旧 H-16）。
 *
 * 断言绑定方案第6节：退出前尾部落库、无悬空进度。
 * 关闭页面后由测试进程直查隔离 DB 验证尾部数据落库（禁页面内日志自证）；
 * pagehide/keepalive 送达路径经真实页面关闭触发。
 */
test("页面退出前尾部持久化送达", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(120000);
    /** 证据记录器（fixtures 自动挂载，显式取用以记录外部时间线与库路径）。 */
    const recorder = evidence as unknown as {
        step: (name: string, detail?: unknown) => void;
    };
    /** 当次运行隔离库路径（evidence-recorder 同源直查）。 */
    const dbFile: string = resolveIsolationDbPath(harnessEnv.runId);
    recorder.step("隔离库直查路径", { dbFile });
    /** 本用例唯一尾部提示词（关闭后直查落库的键）。 */
    const tailPrompt: string = `L3尾部${Date.now()}${Math.floor(Math.random() * 100000)}请讲一个森林守护队的故事。`;

    // 中文注释：经真实访客 API 进入创作页（双浏览器稳态，见 helpers/auth）。
    await ensureGuestByApi(page, harnessEnv.appUrl);

    // 中文注释：另开退出页（保留 fixture 页供 teardown），在退出页完成一次真实创作。
    const exitPage = await page.context().newPage();
    await exitPage.goto(`${harnessEnv.appUrl}/chat`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await dismissOnboarding(exitPage);
    const composer = exitPage.getByPlaceholder("请输入内容...");
    await composer.fill(tailPrompt);
    await exitPage.getByRole("button", { name: "发送" }).click({ timeout: 15000 });
    await expect(composer).toBeEnabled({ timeout: 90000 });
    recorder.step("尾部投递完成", { tailPrompt });
    /** 投递后访客聊天行数基线（关闭前）。 */
    const chatBefore: number = countTableRows(dbFile, "GuestChatMessage");

    // 中文注释：真实页面关闭触发 pagehide/keepalive 送达（产品 beforeunload/pagehide 接线）。
    /** 关闭前测试进程时间戳（外部时间线）。 */
    const beforeCloseMs: number = Date.now();
    recorder.step("关闭退出页", { beforeCloseMs });
    await exitPage.close();
    /** 关闭后静置，待 keepalive 落库完成（测试进程外部等待）。 */
    await page.waitForTimeout(5000);
    /** 关闭后测试进程时间戳。 */
    const afterCloseMs: number = Date.now();
    recorder.step("关闭后直查", { afterCloseMs });

    // 中文注释：关闭后由测试进程直查隔离 DB（禁页面内日志自证）。
    /** 关闭后访客聊天行数（尾部不得丢失）。 */
    const chatAfter: number = countTableRows(dbFile, "GuestChatMessage");
    expect(chatAfter).toBeGreaterThanOrEqual(chatBefore);
    expect(chatAfter).toBeGreaterThanOrEqual(1);
    /** 尾部提示词片段（唯一键前 12 字，LIKE 直查落库内容）。 */
    const tailFragment: string = tailPrompt.slice(0, 12);
    expect(guestChatContains(dbFile, tailFragment)).toBe(true);
    recorder.step("尾部落库", { chatBefore, chatAfter, beforeCloseMs, afterCloseMs });
});
