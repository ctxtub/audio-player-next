import { test, expect } from '../../fixtures/auth.fixture';

/**
 * TabBar 导航测试 — 验证已认证用户可通过底部 TabBar 切换页面。
 */
test.describe('TabBar 导航', () => {
  test('已认证用户可见 TabBar 并切换到各页面', async ({ authedPage: page }) => {
    await page.goto('/chat');
    await page.waitForLoadState('networkidle');

    /* TabBar 导航栏可见 */
    const nav = page.locator('[aria-label="主导航"]');
    await expect(nav).toBeVisible();

    /* 创作 tab 默认激活 */
    const chatTab = page.getByRole('tab', { name: '创作' });
    await expect(chatTab).toHaveAttribute('aria-selected', 'true');

    /* 点击播放器 tab */
    const playerTab = page.getByRole('tab', { name: '播放器' });
    await playerTab.click();
    await expect(page).toHaveURL(/\/player/);
    await expect(playerTab).toHaveAttribute('aria-selected', 'true');

    /* 点击设置 tab */
    const settingTab = page.getByRole('tab', { name: '设置' });
    await settingTab.click();
    await expect(page).toHaveURL(/\/setting/);
    await expect(settingTab).toHaveAttribute('aria-selected', 'true');

    /* 点击创作 tab 回到聊天页 */
    await chatTab.click();
    await expect(page).toHaveURL(/\/chat/);
    await expect(chatTab).toHaveAttribute('aria-selected', 'true');
  });
});
