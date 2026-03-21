/**
 * tRPC Context 模块
 *
 * 定义请求上下文结构，包含认证信息解析。
 */

import { cookies } from 'next/headers';

import type { AuthSession } from '@/types/auth';
import { decodeSession, SESSION_COOKIE } from '@/lib/session';

/**
 * tRPC 请求上下文类型。
 */
export type Context = {
    /** 当前登录的用户会话，未登录时为 null。 */
    session: AuthSession | null;
};

/**
 * 从 Cookie 解析认证会话。
 * @param cookieStore Next.js cookies() 返回的存储。
 */
const parseSession = (cookieStore: Awaited<ReturnType<typeof cookies>>): AuthSession | null => {
    const value = cookieStore.get(SESSION_COOKIE)?.value;
    if (!value) return null;
    return decodeSession(value);
};

/**
 * 创建 tRPC 请求上下文。
 */
export const createContext = async (): Promise<Context> => {
    const cookieStore = await cookies();
    const session = parseSession(cookieStore);

    return {
        session,
    };
};
