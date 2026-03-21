/**
 * 会话编解码工具
 *
 * 使用 TextEncoder/TextDecoder + btoa/atob 实现，兼容 Edge Runtime 与 Node.js。
 */

import type { AuthSession } from '@/types/auth';

const SESSION_COOKIE = 'auth';
const SESSION_MAX_AGE = 60 * 60 * 24; // 1 day

export { SESSION_COOKIE, SESSION_MAX_AGE };

/**
 * 将会话数据编码为 base64 字符串（支持 Unicode）。
 */
export const encodeSession = (userId: number, nickname: string): string => {
    const json = JSON.stringify({ userId, nickname });
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
};

/**
 * 将 base64 字符串解码为会话数据。解码失败或数据不完整时返回 null。
 */
export const decodeSession = (value: string): AuthSession | null => {
    try {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        const json = new TextDecoder().decode(bytes);
        const parsed = JSON.parse(json) as { userId?: number; nickname?: string };
        if (parsed.userId && parsed.nickname) {
            return { userId: parsed.userId, nickname: parsed.nickname };
        }
        return null;
    } catch {
        return null;
    }
};
