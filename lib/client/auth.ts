/**
 * 认证客户端
 *
 * 使用 tRPC 处理登录、登出、用户信息查询。
 */

import { trpc } from '@/lib/trpc/client';

/**
 * 登录请求参数。
 */
export type LoginParams = {
  username: string;
  password: string;
};

/**
 * 登录成功响应类型。
 */
export type LoginResponse = Awaited<ReturnType<typeof login>>;

/**
 * 用户 Profile 响应类型。
 */
export type ProfileResponse = Awaited<ReturnType<typeof fetchProfile>>;

/**
 * 登录。
 */
export const login = async (params: LoginParams) => {
  return trpc.auth.login.mutate(params);
};

/**
 * 登出。
 */
export const logout = async () => {
  return trpc.auth.logout.mutate();
};

/**
 * 获取当前登录状态。
 */
export const fetchProfile = async () => {
  return trpc.auth.profile.mutate();
};
