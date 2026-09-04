/**
 * 会话编解码工具
 *
 * 使用 TextEncoder/TextDecoder + btoa/atob 实现，兼容 Edge Runtime 与 Node.js。
 */

import crypto from 'node:crypto';
import type { AuthSession } from '@/types/auth';

const SESSION_COOKIE = 'auth';
const SESSION_MAX_AGE = 60 * 60 * 24; // 1 day

export { SESSION_COOKIE, SESSION_MAX_AGE };

interface SessionPayload {
    userId: number;
    nickname: string;
    exp: number;
}

const getSessionSecret = (): string => {
    const secret = process.env.SESSION_SECRET;
    if (!secret) {
        throw new Error('SESSION_SECRET environment variable is required');
    }
    return secret;
};

/**
 * 将会话数据编码并附带 HMAC-SHA256 签名。
 */
export const encodeSession = (userId: number, nickname: string): string => {
    const secret = getSessionSecret();
    const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
    const payload: SessionPayload = { userId, nickname, exp };
    const json = JSON.stringify(payload);
    const payloadB64 = Buffer.from(json, 'utf-8').toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
    return `${payloadB64}.${signature}`;
};

/**
 * 校验签名并解码会话数据。解码失败、签名不匹配或会话过期返回 null。
 */
export const decodeSession = (value: string): AuthSession | null => {
    try {
        const secret = process.env.SESSION_SECRET;
        if (!secret) {
            return null;
        }

        const parts = value.split('.');
        if (parts.length !== 2) {
            return null;
        }

        const [payloadB64, signature] = parts;
        if (!payloadB64 || !signature) {
            return null;
        }

        const expectedSignature = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
        if (signature.length !== expectedSignature.length) {
            return null;
        }

        const sigBuf = Buffer.from(signature);
        const expectedSigBuf = Buffer.from(expectedSignature);
        if (!crypto.timingSafeEqual(sigBuf, expectedSigBuf)) {
            return null;
        }

        const json = Buffer.from(payloadB64, 'base64url').toString('utf-8');
        const parsed = JSON.parse(json) as Partial<SessionPayload>;

        if (typeof parsed.exp !== 'number' || Math.floor(Date.now() / 1000) > parsed.exp) {
            return null;
        }

        if (typeof parsed.userId === 'number' && typeof parsed.nickname === 'string' && parsed.nickname) {
            return { userId: parsed.userId, nickname: parsed.nickname };
        }

        return null;
    } catch {
        return null;
    }
};
