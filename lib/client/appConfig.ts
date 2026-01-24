/**
 * 应用配置客户端
 *
 * 使用 tRPC 获取应用运行时配置。
 */

import { trpc } from '@/lib/trpc/client';

/**
 * 应用配置响应结构类型。
 */
export type AppConfigResponse = Awaited<ReturnType<typeof fetchAppConfig>>;

/**
 * 获取应用配置。
 */
export const fetchAppConfig = async () => {
  return trpc.config.get.mutate();
};
