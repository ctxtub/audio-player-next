import { createHttpClient } from '@/lib/http/common';

/**
 * 浏览器环境下使用的 axios 实例，自动附带凭证。
 */
export const browserHttp = createHttpClient({
  withCredentials: true,
});
