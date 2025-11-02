import { createHttpClient } from '@/lib/http/common';

/**
 * 服务端 HTTP 客户端的默认超时时间（毫秒），可通过环境变量覆盖。
 */

const defaultTimeout = Number(process.env.HTTP_SERVER_TIMEOUT_MS ?? '60000');

/**
 * 服务端调用上游接口的 axios 实例，统一处理错误与超时。
 */
export const serverHttp = createHttpClient({
  timeout: defaultTimeout,
});
