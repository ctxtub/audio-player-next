/**
 * Next.js cookies() mock 工厂。
 *
 * Auth router 依赖 `cookies()` 读写 Cookie，
 * 在测试环境中使用 Map 模拟 cookie store。
 */

import { vi } from 'vitest';

/** 内部存储，模拟浏览器 cookie jar。 */
const cookieJar = new Map<string, string>();

/** mock cookie store，实现 get / set / delete 接口。 */
export const mockCookieStore = {
  get: vi.fn((name: string) => {
    const value = cookieJar.get(name);
    return value != null ? { name, value } : undefined;
  }),
  set: vi.fn((options: { name: string; value: string; [key: string]: unknown }) => {
    cookieJar.set(options.name, options.value);
  }),
  delete: vi.fn((name: string) => {
    cookieJar.delete(name);
  }),
};

/** 清空 cookie jar，供 beforeEach 调用。 */
export const resetCookieStore = () => {
  cookieJar.clear();
  mockCookieStore.get.mockClear();
  mockCookieStore.set.mockClear();
  mockCookieStore.delete.mockClear();

  /** 重新绑定 get 的实现（mockClear 会清除 implementation） */
  mockCookieStore.get.mockImplementation((name: string) => {
    const value = cookieJar.get(name);
    return value != null ? { name, value } : undefined;
  });
  mockCookieStore.set.mockImplementation(
    (options: { name: string; value: string; [key: string]: unknown }) => {
      cookieJar.set(options.name, options.value);
    }
  );
  mockCookieStore.delete.mockImplementation((name: string) => {
    cookieJar.delete(name);
  });
};

/**
 * 拦截 `next/headers` 模块，将 cookies() 替换为 mock 实现。
 */
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => mockCookieStore),
}));
