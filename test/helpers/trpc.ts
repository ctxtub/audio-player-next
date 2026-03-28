/**
 * tRPC caller 工厂，用于在测试中直接调用 procedure。
 *
 * 基于 tRPC createCallerFactory 创建，无需 HTTP 传输层，
 * 完整执行中间件链与 Zod 校验。
 */

import { createCallerFactory } from '@/lib/trpc/init';
import { appRouter } from '@/lib/trpc/routers';
import type { Context } from '@/lib/trpc/context';

/** 根据 appRouter 创建的 caller 工厂函数。 */
const createCaller = createCallerFactory(appRouter);

/**
 * 创建未登录状态的 caller。
 * @returns tRPC caller（session 为 null）
 */
export const createPublicCaller = () =>
  createCaller({ session: null } satisfies Context);

/**
 * 创建已登录状态的 caller。
 * @param userId 用户 ID
 * @param nickname 用户昵称
 * @returns tRPC caller（携带 session）
 */
export const createAuthedCaller = (userId = 1, nickname = 'testuser') =>
  createCaller({ session: { userId, nickname } } satisfies Context);
