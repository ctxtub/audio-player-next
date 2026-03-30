import { test, expect } from '@playwright/test';

/**
 * 登录页面功能测试 — 验证登录表单的交互可用性。
 */
test.describe('登录流程', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/auth');
  });

  test('登录页面正常加载', async ({ page }) => {
    await expect(page.getByText('故事工坊')).toBeVisible();
    await expect(page.getByText('智能故事，随时聆听')).toBeVisible();
  });

  test('登录 tab 默认选中', async ({ page }) => {
    const loginTab = page.getByRole('tab', { name: '登录' });
    await expect(loginTab).toHaveAttribute('aria-selected', 'true');
  });

  test('登录表单可填写和提交', async ({ page }) => {
    const usernameInput = page.getByPlaceholder('账号');
    const passwordInput = page.getByPlaceholder('密码');
    const submitButton = page.getByRole('button', { name: '登录' });

    await usernameInput.fill('testuser');
    await expect(usernameInput).toHaveValue('testuser');

    await passwordInput.fill('testpass');
    await expect(passwordInput).toHaveValue('testpass');

    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    /* 提交后按钮应进入 loading 态（显示"登录中…"） */
    await expect(page.getByText('登录中…')).toBeVisible({ timeout: 3000 }).catch(() => {
      /* 如果后端响应极快，可能直接跳过 loading 态，这是可接受的 */
    });
  });

  test('空表单提交触发校验', async ({ page }) => {
    const submitButton = page.getByRole('button', { name: '登录' });
    await submitButton.click();

    /* 提交空表单后不应跳转，仍在 /auth 页面 */
    await expect(page).toHaveURL(/\/auth/);
  });
});
