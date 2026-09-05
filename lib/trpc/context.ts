/**
 * tRPC Context 模块
 *
 * 定义请求上下文结构，包含认证信息解析、访客模式识别与安全客户端 IP 提取。
 */

import { cookies, headers } from 'next/headers';

import type { AuthSession } from '@/types/auth';
import { decodeSession, SESSION_COOKIE } from '@/lib/session';

export const GUEST_COOKIE = 'guest';
export const GUEST_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

/**
 * 构造访客 Cookie 的 Set-Cookie 头字符串。
 */
export const buildGuestCookieHeader = (guestId: string): string => {
    const isProd = process.env.NODE_ENV === 'production';
    return `${GUEST_COOKIE}=${guestId}; Path=/; Max-Age=${GUEST_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${isProd ? '; Secure' : ''}`;
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

    let guestId: string | null = null;
    let needsUpgrade = false;

    if (guestValue) {
        if (guestValue.startsWith('g_')) {
            guestId = guestValue;
        } else if (guestValue === '1') {
            // 存量旧版 guest=1 向上平滑升级为具名 g_<uuid>
            guestId = `g_${crypto.randomUUID()}`;
            needsUpgrade = true;
        }
    }

    const isGuest = guestId !== null;

    if (needsUpgrade && guestId) {
        try {
            const cookieStore = await cookies();
            cookieStore.set({
                name: GUEST_COOKIE,
                value: guestId,
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                path: '/',
                maxAge: GUEST_COOKIE_MAX_AGE,
            });
        } catch {
            // 单元测试或只读上下文
        }

        if (opts?.resHeaders) {
            opts.resHeaders.append('Set-Cookie', buildGuestCookieHeader(guestId));
        }
    }

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

