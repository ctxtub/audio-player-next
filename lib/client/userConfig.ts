/**
 * 用户配置客户端
 *
 * 使用 tRPC 读写当前登录用户的个性化配置。
 */

import { trpc } from '@/lib/trpc/client';
import type { UserConfigPatch, UserConfigSeed } from '@/lib/trpc/schemas/config';

/** 用户配置 DTO 响应类型（由服务端推导）。 */
export type MyConfigResponse = Awaited<ReturnType<typeof fetchMyConfig>>;

/**
 * 获取当前用户配置；可携带本地 seed 供首次建行迁移使用。
 * @param seed 本地配置，仅服务端无行时被消费。
 */
export const fetchMyConfig = async (seed?: UserConfigSeed) => {
  return trpc.config.getMine.query(seed ? { seed } : undefined);
};

/**
 * 保存当前用户配置（增量）。
 * @param patch 待更新的字段片段。
 */
export const saveMyConfig = async (patch: UserConfigPatch) => {
  return trpc.config.updateMine.mutate(patch);
};
