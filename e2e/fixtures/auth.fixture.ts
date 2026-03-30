import { test as base, type Page } from '@playwright/test';

/**
 * 会话编码函数，复制自 lib/session.ts 的 encodeSession 逻辑。
 * 避免直接导入项目源码（e2e 独立于主 tsconfig）。
 */
function encodeSession(userId: number, nickname: string): string {
  const json = JSON.stringify({ userId, nickname });
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Session cookie 名称，与 lib/session.ts 中的 SESSION_COOKIE 保持一致 */
const SESSION_COOKIE = 'auth';

/** 扩展 test fixture，提供已认证和访客两种预设页面 */
export const test = base.extend<{ authedPage: Page; guestPage: Page }>({
  /** 已登录用户页面：预注入 session cookie，可直接访问受保护路由 */
  authedPage: async ({ browser }, use) => {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: SESSION_COOKIE,
        value: encodeSession(1, '测试用户'),
        domain: 'localhost',
        path: '/',
      },
    ]);
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  /** 访客模式页面：预注入 guest cookie，可访问受保护路由但功能受限 */
  guestPage: async ({ browser }, use) => {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: 'guest',
        value: '1',
        domain: 'localhost',
        path: '/',
      },
    ]);
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect } from '@playwright/test';
