/**
 * Next.js cookies() mock 工厂。
 *
 * Auth router 依赖 `cookies()` 读写 Cookie，
 * 在测试环境中使用 Map 模拟 cookie store。
 */

import { vi, beforeEach } from 'vitest';

/** 内部存储，模拟浏览器 cookie jar。 */
const cookieJar = new Map<string, string>();

/** 根据 cookie jar 查找指定名称的 cookie。 */
const getCookie = (name: string) => {
  const value = cookieJar.get(name);
  return value != null ? { name, value } : undefined;
};

/** 设置 cookie。 */
const setCookie = (options: { name: string; value: string; [key: string]: unknown }) => {
  cookieJar.set(options.name, options.value);
};

/** 删除 cookie。 */
const deleteCookie = (name: string) => {
  cookieJar.delete(name);
};

/** mock cookie store，实现 get / set / delete 接口。 */
export const mockCookieStore = {
  get: vi.fn(getCookie),
  set: vi.fn(setCookie),
  delete: vi.fn(deleteCookie),
};

/**
 * 每个测试前自动重置 cookie 状态，清空 jar 和调用记录，
 * 并恢复默认实现。
 */
beforeEach(() => {
  cookieJar.clear();
  mockCookieStore.get.mockReset().mockImplementation(getCookie);
  mockCookieStore.set.mockReset().mockImplementation(setCookie);
  mockCookieStore.delete.mockReset().mockImplementation(deleteCookie);
});

/**
 * 拦截 `next/headers` 模块，将 cookies() 替换为 mock 实现。
 */
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => mockCookieStore),
}));
