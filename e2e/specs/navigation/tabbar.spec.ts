import { test, expect } from '../../fixtures/auth.fixture';
import { mockConfigGet } from '../../helpers/trpc-mock';

/**
 * TabBar 导航测试 — 验证已认证用户可通过底部 TabBar 切换页面。
 */
test.describe('TabBar 导航', () => {
  /* 该测试包含多次跨页导航，并行执行时 dev server 压力大，延长超时 */
  test.slow();
  test('已认证用户可见 TabBar 并切换到各页面', async ({ authedPage: page }) => {
    /* 通过 addInitScript 在页面脚本执行前预设 sessionStorage，跳过 OnboardingModal（其 overlay 会拦截所有指针事件） */
    await page.addInitScript(() => sessionStorage.setItem('chat_onboarding_seen', 'true'));
    /* mock config.get，确保 ConfigInitializer 能完成初始化并渲染主布局 */
    await mockConfigGet(page);
    await page.goto('/chat');
    await page.waitForLoadState('domcontentloaded');

    /* TabBar 导航栏可见（等待 React hydration 完成） */
    const nav = page.locator('[aria-label="主导航"]');
    await expect(nav).toBeVisible();

    /* 创作 tab 默认激活 */
    const chatTab = page.getByRole('tab', { name: '创作' });
    await expect(chatTab).toHaveAttribute('aria-selected', 'true');

    /* 点击播放器 tab — 等待 URL 变化，并确认新页面的 TabBar 已渲染 */
    const playerTab = page.getByRole('tab', { name: '播放器' });
    await playerTab.click();
    await page.waitForURL(/\/player/);
    await expect(nav).toBeVisible();
    await expect(playerTab).toHaveAttribute('aria-selected', 'true');

    /* 点击设置 tab */
    const settingTab = page.getByRole('tab', { name: '设置' });
    await settingTab.click();
    await page.waitForURL(/\/setting/);
    await expect(nav).toBeVisible();
    await expect(settingTab).toHaveAttribute('aria-selected', 'true');

    /* 点击创作 tab 回到聊天页 */
    await chatTab.click();
    await page.waitForURL(/\/chat/);
    await expect(nav).toBeVisible();
    await expect(chatTab).toHaveAttribute('aria-selected', 'true');
  });
});
