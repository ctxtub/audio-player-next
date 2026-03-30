import { test, expect } from '../../fixtures/auth.fixture';
import { mockConfigGet } from '../../helpers/trpc-mock';

/**
 * 播放器控制测试 — 验证播放器页面加载和速度菜单交互。
 */
test.describe('播放器控制', () => {
  test('播放器页面正常加载', async ({ authedPage: page }) => {
    await mockConfigGet(page);
    await page.goto('/player');
    await page.waitForLoadState('domcontentloaded');

    /* 速度按钮可见 */
    const speedButton = page.locator('[aria-label="播放速度"]');
    await expect(speedButton).toBeVisible();
  });

  test('点击速度按钮弹出速度菜单', async ({ authedPage: page }) => {
    await mockConfigGet(page);
    await page.goto('/player');
    await page.waitForLoadState('domcontentloaded');

    const speedButton = page.locator('[aria-label="播放速度"]');
    await speedButton.click();

    /* 速度选项应可见 */
    await expect(page.getByText('0.8x')).toBeVisible();
    await expect(page.getByText('1.5x')).toBeVisible();
  });
});
