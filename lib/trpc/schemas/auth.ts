/**
 * 认证相关 Zod Schemas
 */

import { z } from 'zod';

/**
 * 登录请求 Schema。
 */
export const loginInputSchema = z.object({
    username: z.string().min(1, '用户名不能为空'),
    password: z.string().min(1, '密码不能为空'),
});

/**
 * 登录请求类型。
 */
export type LoginInput = z.infer<typeof loginInputSchema>;
