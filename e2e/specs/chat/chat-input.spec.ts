import { test, expect } from '../../fixtures/auth.fixture';
import { blockAiRoutes } from '../../helpers/trpc-mock';

/**
 * 聊天输入框测试 — 验证 Composer 组件的交互可用性。
 */
test.describe('聊天输入', () => {
  test('输入框可聚焦、输入文本、点击发送', async ({ authedPage: page }) => {
    await blockAiRoutes(page);
    await page.goto('/chat');
    await page.waitForLoadState('networkidle');

    /* 输入框可见且可聚焦 */
    const input = page.getByPlaceholder('请输入内容...');
    await expect(input).toBeVisible();
    await input.focus();
    await input.fill('你好，给我讲一个故事');
    await expect(input).toHaveValue('你好，给我讲一个故事');

    /* 发送按钮可点击 */
    const sendButton = page.getByRole('button', { name: '发送' });
    await expect(sendButton).toBeVisible();
    await sendButton.click();
  });
});
