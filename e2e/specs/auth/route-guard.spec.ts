import { test, expect } from '@playwright/test';

/**
 * 路由守卫测试 — 验证未认证用户访问受保护路由时被正确重定向到登录页。
 */
test.describe('路由守卫', () => {
  test('未认证用户访问 /chat 被重定向到 /auth', async ({ page }) => {
    await page.goto('/chat');
    await expect(page).toHaveURL(/\/auth/);
  });

  test('未认证用户访问 /player 被重定向到 /auth', async ({ page }) => {
    await page.goto('/player');
    await expect(page).toHaveURL(/\/auth/);
  });

  test('未认证用户访问 /setting 被重定向到 /auth', async ({ page }) => {
    await page.goto('/setting');
    await expect(page).toHaveURL(/\/auth/);
  });

  test('重定向携带 from 参数', async ({ page }) => {
    await page.goto('/chat');
    await expect(page).toHaveURL(/\/auth\?from=%2Fchat/);
  });
});
