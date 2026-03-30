import type { Page } from '@playwright/test';

/**
 * 构造 tRPC 单条成功响应体的工具函数。
 * @param data 响应数据（将作为 json 字段嵌入）
 */
function trpcOk(data: unknown) {
  return JSON.stringify([{ result: { data: { json: data } } }]);
}

/**
 * 拦截 config.get tRPC 接口，返回最小有效配置，确保 ConfigInitializer 能完成初始化。
 * 在所有需要访问主应用页面（/chat、/player、/setting）的测试中调用此函数。
 */
export async function mockConfigGet(page: Page) {
  await page.route('**/api/trpc/config.get**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: trpcOk({
        voicesList: [{ value: 'alloy', label: 'Alloy', description: '中性、平衡' }],
        voiceId: 'alloy',
        playDuration: 20,
        floatingPlayerEnabled: true,
      }),
    });
  });
}

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
