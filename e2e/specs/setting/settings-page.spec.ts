import { test, expect } from '../../fixtures/auth.fixture';

/**
 * 设置页面加载测试 — 验证设置页各区块正常渲染可见。
 */
test.describe('设置页面', () => {
  test('设置页各区块正常加载', async ({ authedPage: page }) => {
    await page.goto('/setting');
    await page.waitForLoadState('networkidle');

    /* 各配置区块标题可见 */
    await expect(page.getByText('播放时长')).toBeVisible();
    await expect(page.getByText('播放语速')).toBeVisible();
    await expect(page.getByText('主题设置')).toBeVisible();
    await expect(page.getByText('语音音色')).toBeVisible();
  });

  test('播放浮窗开关可操作', async ({ authedPage: page }) => {
    await page.goto('/setting');
    await page.waitForLoadState('networkidle');

    await expect(page.getByText('播放浮窗')).toBeVisible();
    const toggle = page.locator('[aria-label="播放浮窗开关"]');
    await expect(toggle).toBeVisible();
    await toggle.click();
  });
});
