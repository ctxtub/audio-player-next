/**
 * 认证相关 Zod Schemas
 */

import { z } from 'zod';

/**
 * 登录请求 Schema。
 */
export const loginInputSchema = z.object({
    username: z.string().min(2, '用户名至少 2 个字符'),
    password: z.string().min(1, '密码不能为空'),
});

/**
 * 登录请求类型。
 */
export type LoginInput = z.infer<typeof loginInputSchema>;

/**
 * 注册请求 Schema。
 */
export const registerInputSchema = z.object({
    username: z.string().min(2, '用户名至少 2 个字符').max(32, '用户名最多 32 个字符'),
    password: z.string().min(6, '密码至少 6 个字符').max(64, '密码最多 64 个字符'),
    nickname: z.string().max(32, '昵称最多 32 个字符').optional(),
});

/**
 * 注册请求类型。
 */
export type RegisterInput = z.infer<typeof registerInputSchema>;
