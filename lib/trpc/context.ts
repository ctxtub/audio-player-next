/**
 * tRPC Context 模块
 *
 * 定义请求上下文结构，包含认证信息解析、访客模式识别与安全客户端 IP 提取。
 */

import { cookies, headers } from 'next/headers';

import type { AuthSession } from '@/types/auth';
import { decodeSession, SESSION_COOKIE } from '@/lib/session';

export const GUEST_COOKIE = 'guest';

/**
 * tRPC 请求上下文类型。
 */
export type Context = {
    /** 当前登录的用户会话，未登录时为 null。 */
    session: AuthSession | null;
    /** 是否处于访客模式（guest cookie 值为 '1'）。 */
    isGuest: boolean;
    /** 客户端安全 IP 地址。 */
    clientIp: string;
};

export type CreateContextOptions = {
    req?: Request;
    resHeaders?: Headers;
};

/**
 * 从 Cookie 请求头中解析键值对。
 */
const parseCookiesFromHeader = (cookieHeader: string | null): Record<string, string> => {
    if (!cookieHeader) return {};
    const result: Record<string, string> = {};
    for (const item of cookieHeader.split(';')) {
        const [rawKey, ...rawVal] = item.trim().split('=');
        if (rawKey) {
            result[rawKey] = decodeURIComponent(rawVal.join('='));
        }
    }
    return result;
};

/**
 * 提取客户端安全 IP 地址。
 * 依次检查 cf-connecting-ip、x-real-ip、x-forwarded-for（取首个有效 IP），回退到 127.0.0.1。
 * 优先信任反向代理/CDN 注入的 cf-connecting-ip 与 x-real-ip，防止客户端伪造 x-forwarded-for 绕过速率限制。
 */
export const getSafeClientIp = (
    headersList?: Headers | { get(name: string): string | null } | null
): string => {
    if (!headersList) return '127.0.0.1';
    const cfConnectingIp = headersList.get('cf-connecting-ip');
    if (cfConnectingIp?.trim()) return cfConnectingIp.trim();
    const xRealIp = headersList.get('x-real-ip');
    if (xRealIp?.trim()) return xRealIp.trim();
    const xForwardedFor = headersList.get('x-forwarded-for');
    if (xForwardedFor) {
        const clientIp = xForwardedFor.split(',')[0]?.trim();
        if (clientIp) return clientIp;
    }
    return '127.0.0.1';
};

/**
 * 创建 tRPC 请求上下文。
 */
export const createContext = async (opts?: CreateContextOptions): Promise<Context> => {
    let sessionValue: string | undefined;
    let guestValue: string | undefined;

    try {
        const cookieStore = await cookies();
        sessionValue = cookieStore.get(SESSION_COOKIE)?.value;
        guestValue = cookieStore.get(GUEST_COOKIE)?.value;
    } catch {
        // 单元测试或非 Next.js 请求上下文环境
    }

    if (!sessionValue || !guestValue) {
        const cookieHeader = opts?.req?.headers?.get('cookie');
        if (cookieHeader) {
            const parsed = parseCookiesFromHeader(cookieHeader);
            if (!sessionValue) sessionValue = parsed[SESSION_COOKIE];
            if (!guestValue) guestValue = parsed[GUEST_COOKIE];
        }
    }

    const session = sessionValue ? decodeSession(sessionValue) : null;
    const isGuest = guestValue === '1';

    let reqHeaders: Headers | { get(name: string): string | null } | null = opts?.req?.headers ?? null;
    if (!reqHeaders) {
        try {
            reqHeaders = await headers();
        } catch {
            // 单元测试或非 Next.js 上下文环境
        }
    }

    const clientIp = getSafeClientIp(reqHeaders);

    return {
        session,
        isGuest,
        clientIp,
    };
};
