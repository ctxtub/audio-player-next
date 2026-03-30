import type { Page } from '@playwright/test';

/**
 * 拦截 AI 相关 tRPC 接口，防止 E2E 测试时产生真实 OpenAI API 调用。
 * 仅拦截 agent.interact 和 tts.synthesize，其余接口走真实后端。
 */
export async function blockAiRoutes(page: Page) {
  /** 拦截 agent.interact —— 返回空的流式响应 */
  await page.route('**/api/trpc/agent.interact**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          result: {
            data: {
              json: { text: '', user_intent: 'chat', audio_url: null },
            },
          },
        },
      ]),
    });
  });

  /** 拦截 tts.synthesize —— 返回空音频 URL */
  await page.route('**/api/trpc/tts.synthesize**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          result: {
            data: {
              json: { url: '' },
            },
          },
        },
      ]),
    });
  });
}
