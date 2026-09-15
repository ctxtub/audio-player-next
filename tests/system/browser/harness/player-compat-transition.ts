import type { Page } from "@playwright/test";

/**
 * M9-01 fixup harness 侧 App Router client-transition 钩子（测试专用）。
 *
 * 背景：M9-01 送审裁决 Blocking=1——case 2 用 `page.goto('/player…')`（整页
 * document navigation）冒充应用内 redirect，没有真正验证冻结契约“应用内
 * redirect 不清 transport”。M7 已切断全部产品 /player client 入口（P4 静态守卫
 * 锁定 `components/**` + `app/(main)/**` + `lib/client/**` + `stores/**` 零新增
 * `/player` 导航），故不得给产品代码新增任何 /player 入口/Link/push。
 *
 * 本钩子挂在 harness/probe 侧（`tests/system/browser/harness/`，P4 审计范围外，
 * 产品零改动）：经 Next 调试全局 `window.next.router.push()` 发起与产品 TabBar
 *（`useRouter().push()`）同 reducer 路径的 App Router client transition，走 RSC
 * fetch + server `redirect('/library')` 跟随，全程不发生 document reload。
 * 注意：App Router 下裸 `<a>` 点击（含合成 dispatch 与可信点击）不被客户端路由
 * 拦截，一律退化为整页 MPA 导航（与 `page.goto` 等价），故严禁用锚点冒充；此处
 * 直调 router 实例是唯一 harness 侧真 client transition。router 不可用即 loudly
 * 抛错，绝不静默退化为整页导航。调用方以 window/docToken + audio 元素 marker
 * 存活证明同 document（client transition），再锁冻结断言。
 *
 * @param page Playwright 页面（须已在 (main) 布局内，Probe/Host 已挂载）
 * @param target 兼容入口目标（须为同源 /player 形态，默认含旧 query/hash）
 */
export async function transitionToPlayerCompatViaClientRouter(
    page: Page,
    target: string = "/player?from=active#keep",
): Promise<void> {
    if (!target.startsWith("/player")) {
        throw new Error(`[compat-transition] 非法目标（须为 /player 形态）：${target}`);
    }
    await page.evaluate((href: string) => {
        const w = window as unknown as {
            next?: { router?: { push: (h: string) => void } };
        };
        const router = w.next?.router;
        if (!router || typeof router.push !== "function") {
            throw new Error(
                `[compat-transition] window.next.router.push 不可用（next=${typeof w.next} router=${typeof router}），拒绝退化为整页导航`,
            );
        }
        router.push(href);
    }, target);
}
