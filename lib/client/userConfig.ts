/**
 * 配置客户端服务
 *
 * 使用 tRPC 读写当前主体（已登录用户或具名访客）的云端个性化配置。
 */

import { trpc } from '@/lib/trpc/client';
import type { UserConfigPatch } from '@/lib/trpc/schemas/config';

/** 配置 DTO 响应类型（由服务端推导）。 */
export type MyConfigResponse = Awaited<ReturnType<typeof fetchMyConfig>>;

/**
 * 获取当前主体的云端配置（登录用户或具名访客）。
 */
export const fetchMyConfig = async () => {
  return trpc.config.getMine.query();
};

/**
 * 保存当前主体的配置（增量）。
 * @param patch 待更新的字段片段。
 */
export const saveMyConfig = async (patch: UserConfigPatch) => {
  return trpc.config.updateMine.mutate(patch);
};

