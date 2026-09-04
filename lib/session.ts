/**
 * 会话编解码工具
 *
 * 使用 TextEncoder/TextDecoder + btoa/atob 实现，兼容 Edge Runtime 与 Node.js。
 */

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

// ============================================================================
// Cross-platform HMAC-SHA256 (Edge Runtime & Node.js Compatible)
// ============================================================================

const sha256 = (data: Uint8Array): Uint8Array => {
    const rightRotate = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));
    const k = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

    const byteLen = data.length;
    const bitLen = byteLen * 8;
    const wordsLen = (((byteLen + 8) >> 6) + 1) * 16;
    const w = new Uint32Array(wordsLen);
    for (let i = 0; i < byteLen; i++) {
        w[i >> 2] |= data[i] << (24 - (i % 4) * 8);
    }
    w[byteLen >> 2] |= 0x80 << (24 - (byteLen % 4) * 8);
    w[wordsLen - 1] = bitLen;
    w[wordsLen - 2] = Math.floor(bitLen / 0x100000000);

    const schedule = new Uint32Array(64);
    for (let i = 0; i < wordsLen; i += 16) {
        for (let j = 0; j < 16; j++) schedule[j] = w[i + j];
        for (let j = 16; j < 64; j++) {
            const s0 = rightRotate(schedule[j - 15], 7) ^ rightRotate(schedule[j - 15], 18) ^ (schedule[j - 15] >>> 3);
            const s1 = rightRotate(schedule[j - 2], 17) ^ rightRotate(schedule[j - 2], 19) ^ (schedule[j - 2] >>> 10);
            schedule[j] = (schedule[j - 16] + s0 + schedule[j - 7] + s1) | 0;
        }
        let a = hash[0], b = hash[1], c = hash[2], d = hash[3], e = hash[4], f = hash[5], g = hash[6], h = hash[7];
        for (let j = 0; j < 64; j++) {
            const S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
            const ch = (e & f) ^ ((~e) & g);
            const temp1 = (h + S1 + ch + k[j] + schedule[j]) | 0;
            const S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) | 0;

            h = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;
        }
        hash[0] = (hash[0] + a) | 0; hash[1] = (hash[1] + b) | 0; hash[2] = (hash[2] + c) | 0; hash[3] = (hash[3] + d) | 0;
        hash[4] = (hash[4] + e) | 0; hash[5] = (hash[5] + f) | 0; hash[6] = (hash[6] + g) | 0; hash[7] = (hash[7] + h) | 0;
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
        out[i * 4] = (hash[i] >>> 24) & 0xff;
        out[i * 4 + 1] = (hash[i] >>> 16) & 0xff;
        out[i * 4 + 2] = (hash[i] >>> 8) & 0xff;
        out[i * 4 + 3] = hash[i] & 0xff;
    }
    return out;
};

const hmacSha256 = (keyStr: string, dataStr: string): string => {
    let key = Buffer.from(keyStr, 'utf-8');
    if (key.length > 64) key = Buffer.from(sha256(key));
    const kPadOuter = new Uint8Array(64);
    const kPadInner = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
        const kByte = i < key.length ? key[i] : 0;
        kPadOuter[i] = kByte ^ 0x5c;
        kPadInner[i] = kByte ^ 0x36;
    }
    const dataBuf = Buffer.from(dataStr, 'utf-8');
    const innerInput = Buffer.concat([Buffer.from(kPadInner), dataBuf]);
    const innerHash = sha256(innerInput);
    const outerInput = Buffer.concat([Buffer.from(kPadOuter), Buffer.from(innerHash)]);
    return Buffer.from(sha256(outerInput)).toString('base64url');
};

const timingSafeEqual = (a: string, b: string): boolean => {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
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
    const signature = hmacSha256(secret, payloadB64);
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

        const expectedSignature = hmacSha256(secret, payloadB64);
        if (!timingSafeEqual(signature, expectedSignature)) {
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
