import { test, expect } from '../../fixtures/auth.fixture';
import { mockConfigGet } from '../../helpers/trpc-mock';

/**
 * 主题切换测试 — 验证设置页主题选项可操作且生效。
 */
test.describe('主题切换', () => {
  test('点击暗色模式后 html 元素切换 data-theme', async ({ authedPage: page }) => {
    await mockConfigGet(page);
    await page.goto('/setting');
    await page.waitForLoadState('domcontentloaded');

    /* 主题设置区块可见 */
    await expect(page.getByText('主题设置')).toBeVisible();

    /* 点击暗色模式 */
    await page.getByText('暗色模式').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    /* 点击亮色模式 */
    await page.getByText('亮色模式').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});
