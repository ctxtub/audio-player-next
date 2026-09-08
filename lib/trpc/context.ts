/**
 * tRPC Context 模块
 *
 * 定义请求上下文结构，包含认证信息解析、访客模式识别与安全客户端 IP 提取。
 */

import { cookies, headers } from 'next/headers';

import type { AuthSession } from '@/types/auth';
import { decodeSession, decodeGuestCookie, SESSION_COOKIE } from '@/lib/session';

export const GUEST_COOKIE = 'guest';
export const GUEST_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

/**
 * 构造访客 Cookie 的 Set-Cookie 头字符串（值为已签名 opaque token）。
 */
export const buildGuestCookieHeader = (signedValue: string): string => {
    const isProd = process.env.NODE_ENV === 'production';
    return `${GUEST_COOKIE}=${signedValue}; Path=/; Max-Age=${GUEST_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${isProd ? '; Secure' : ''}`;
};

/**
 * tRPC 请求上下文类型。
 */
export type Context = {
    /** 当前登录的用户会话，未登录时为 null。 */
    session: AuthSession | null;
    /** 具名访客标识符（格式如 g_1234567890abcdef...），非访客为 null。 */
    guestId?: string | null;
    /** 是否处于访客模式。 */
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

    // 访客身份只承认 HMAC 签名合法且未过期的 Cookie 值。
    // 旧式 guest=1、裸 g_<uuid>、伪造/篡改/过期签名一律视为匿名（guardedProcedure 返回 401），
    // 不做平滑升级、不下发任何 Set-Cookie；合法身份须经 auth.enterGuestMode 重新建立。
    const guestId: string | null = guestValue ? decodeGuestCookie(guestValue) : null;

    const isGuest = guestId !== null;

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
        guestId,
        isGuest,
        clientIp,
    };
};

