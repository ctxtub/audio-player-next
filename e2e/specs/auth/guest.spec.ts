import { test, expect } from '@playwright/test';

/**
 * 访客模式测试 — 验证访客入口和访客状态下的路由访问。
 */
test.describe('访客模式', () => {
  test('访客按钮可见且可点击', async ({ page }) => {
    await page.goto('/auth');
    const guestButton = page.getByRole('button', { name: '以访客身份继续使用' });
    await expect(guestButton).toBeVisible();
    await expect(guestButton).toBeEnabled();
  });

  test('点击访客按钮后跳转到主应用', async ({ page }) => {
    /* 拦截 enterGuestMode tRPC 调用，直接返回成功并预设 guest cookie */
    await page.route('**/api/trpc/auth.enterGuestMode**', async (route) => {
      /* 在响应头中设置 guest cookie */
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Set-Cookie': 'guest=1; Path=/' },
        body: JSON.stringify([{ result: { data: { json: { success: true } } } }]),
      });
    });

    await page.goto('/auth');
    await page.getByRole('button', { name: '以访客身份继续使用' }).click();

    /* 访客模式应跳转到 /chat */
    await expect(page).not.toHaveURL(/\/auth/, { timeout: 8000 });
  });
});
