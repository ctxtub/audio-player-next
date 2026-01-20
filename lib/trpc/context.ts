/**
 * tRPC Context 模块
 *
 * 定义请求上下文结构，包含认证信息解析。
 */

import { cookies } from 'next/headers';

import type { AuthSession } from '@/types/auth';

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
    const authCookie = cookieStore.get('auth');
    if (!authCookie?.value) {
        return null;
    }

    try {
        const decoded = Buffer.from(authCookie.value, 'base64').toString('utf-8');
        const parsed = JSON.parse(decoded) as { nickname?: string };
        if (parsed.nickname) {
            return { nickname: parsed.nickname };
        }
        return null;
    } catch {
        return null;
    }
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
