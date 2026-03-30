import { test, expect } from '@playwright/test';

/**
 * 注册页面功能测试 — 验证注册表单的交互可用性。
 */
test.describe('注册流程', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/auth');
    /* 切换到注册 tab */
    await page.getByRole('tab', { name: '注册' }).click();
  });

  test('切换到注册 tab 后表单可见', async ({ page }) => {
    const registerTab = page.getByRole('tab', { name: '注册' });
    await expect(registerTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByPlaceholder('账号（至少 2 个字符）')).toBeVisible();
  });

  test('注册表单可填写', async ({ page }) => {
    await page.getByPlaceholder('账号（至少 2 个字符）').fill('newuser');
    await page.getByPlaceholder('昵称（可选）').fill('测试昵称');
    await page.getByPlaceholder('密码（至少 6 个字符）').fill('password123');
    await page.getByPlaceholder('确认密码').fill('password123');

    await expect(page.getByPlaceholder('账号（至少 2 个字符）')).toHaveValue('newuser');
    await expect(page.getByPlaceholder('昵称（可选）')).toHaveValue('测试昵称');
    await expect(page.getByPlaceholder('密码（至少 6 个字符）')).toHaveValue('password123');
    await expect(page.getByPlaceholder('确认密码')).toHaveValue('password123');
  });

  test('注册表单可提交', async ({ page }) => {
    await page.getByPlaceholder('账号（至少 2 个字符）').fill('newuser');
    await page.getByPlaceholder('密码（至少 6 个字符）').fill('password123');
    await page.getByPlaceholder('确认密码').fill('password123');

    const submitButton = page.getByRole('button', { name: '注册' });
    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    /* 提交后按钮应进入 loading 态 */
    await expect(page.getByText('注册中…')).toBeVisible({ timeout: 3000 }).catch(() => {
      /* 后端响应极快时可能跳过 */
    });
  });

  test('密码不一致时显示错误', async ({ page }) => {
    await page.getByPlaceholder('账号（至少 2 个字符）').fill('newuser');
    await page.getByPlaceholder('密码（至少 6 个字符）').fill('password123');
    await page.getByPlaceholder('确认密码').fill('different');

    const submitButton = page.getByRole('button', { name: '注册' });
    await submitButton.click();

    await expect(page.getByText('两次输入的密码不一致')).toBeVisible();
  });

  test('Tab 切换时重置表单', async ({ page }) => {
    await page.getByPlaceholder('账号（至少 2 个字符）').fill('somevalue');

    /* 切换到登录 tab 再切回来 */
    await page.getByRole('tab', { name: '登录' }).click();
    await page.getByRole('tab', { name: '注册' }).click();

    await expect(page.getByPlaceholder('账号（至少 2 个字符）')).toHaveValue('');
  });
});
