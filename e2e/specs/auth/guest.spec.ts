import { test, expect } from '@playwright/test';

/**
 * 访客模式测试 — 验证访客入口和访客状态下的路由访问。
 */
test.describe('访客模式', () => {
  test('访客按钮可见且可点击', async ({ page }) => {
    await page.goto('/auth');
    const guestButton = page.getByText('以访客身份继续使用');
    await expect(guestButton).toBeVisible();
    await expect(guestButton).toBeEnabled();
  });

  test('点击访客按钮后跳转到主应用', async ({ page }) => {
    await page.goto('/auth');
    await page.getByText('以访客身份继续使用').click();

    /* 访客模式应跳转到 /chat */
    await expect(page).not.toHaveURL(/\/auth/, { timeout: 5000 });
  });
});
