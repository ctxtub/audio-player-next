/**
 * 服务端速率限制模块
 *
 * 基于有界的内存滑动窗口算法，支持容量上限与自动淘汰，防止内存泄漏或恶意 IP 导致 DoS。
 */

import { TRPCError } from '@trpc/server';
import type { AuthSession } from '@/types/auth';

export interface SlidingWindowRateLimiterOptions {
    /** 默认时间窗口（毫秒），默认 60,000ms (1分钟) */
    windowMs?: number;
    /** 内存最大键容纳量，默认 10,000 条 */
    maxKeys?: number;
    /** 时间获取函数，主要供单元测试模拟时间流逝 */
    nowFn?: () => number;
}

export interface RateLimitStatus {
    allowed: boolean;
    limit: number;
    remaining: number;
    resetMs: number;
}

/**
 * 有界内存滑动窗口限流器
 */
export class SlidingWindowRateLimiter {
    private readonly windowMs: number;
    private readonly maxKeys: number;
    private readonly nowFn: () => number;
    private readonly records = new Map<string, number[]>();

    constructor(options: SlidingWindowRateLimiterOptions = {}) {
        this.windowMs = options.windowMs ?? 60_000;
        this.maxKeys = options.maxKeys ?? 10_000;
        this.nowFn = options.nowFn ?? (() => Date.now());
    }

    /**
     * 尝试消耗一次配额。
     * @param key 限流标识键（如 user:123 或 guest:1.2.3.4）
     * @param limit 当前窗口内最大允许请求数
     * @param customWindowMs 可选的窗口大小（毫秒）
     * @returns 是否允许请求
     */
    consume(key: string, limit: number, customWindowMs?: number): boolean {
        return this.checkAndConsume(key, limit, customWindowMs).allowed;
    }

    /**
     * 检查并消耗配额，返回详细状态。
     */
    checkAndConsume(key: string, limit: number, customWindowMs?: number): RateLimitStatus {
        const now = this.nowFn();
        const windowMs = customWindowMs ?? this.windowMs;
        const cutoff = now - windowMs;

        let timestamps = this.records.get(key);
        if (!timestamps) {
            this.ensureCapacity(cutoff);
            timestamps = [];
            this.records.set(key, timestamps);
        } else {
            // 剔除窗口外的过期时间戳
            timestamps = timestamps.filter((ts) => ts > cutoff);
            this.records.set(key, timestamps);
        }

        if (timestamps.length >= limit) {
            const oldestInWindow = timestamps[0] ?? now;
            const resetMs = Math.max(0, oldestInWindow + windowMs - now);
            return {
                allowed: false,
                limit,
                remaining: 0,
                resetMs,
            };
        }

        timestamps.push(now);
        const oldestInWindow = timestamps[0] ?? now;
        const resetMs = Math.max(0, oldestInWindow + windowMs - now);

        return {
            allowed: true,
            limit,
            remaining: limit - timestamps.length,
            resetMs,
        };
    }

    /**
     * 容量保护策略：当键总数达到上限时，淘汰已完全过期的键；若依然超限，按 FIFO 淘汰最老插入的键。
     */
    private ensureCapacity(cutoff: number): void {
        if (this.records.size < this.maxKeys) {
            return;
        }

        // 第一步：清理已完全过期的记录
        for (const [k, timestamps] of this.records.entries()) {
            const hasActive = timestamps.some((ts) => ts > cutoff);
            if (!hasActive) {
                this.records.delete(k);
            }
        }

        // 第二步：若仍然超标，按 FIFO 逐个淘汰最老的键，直到容量处于阈值内
        while (this.records.size >= this.maxKeys) {
            const oldestKey = this.records.keys().next().value;
            if (oldestKey === undefined) break;
            this.records.delete(oldestKey);
        }
    }

    /**
     * 重置所有记录或指定键。
     */
    reset(key?: string): void {
        if (key) {
            this.records.delete(key);
        } else {
            this.records.clear();
        }
    }

    /**
     * 获取当前记录的键数量（供测试检查容量边界）。
     */
    get size(): number {
        return this.records.size;
    }
}

/** 全局默认限流器实例 */
export const defaultRateLimiter = new SlidingWindowRateLimiter();

export interface ProcedureRateLimitOptions {
    /** 访客在窗口期内的最大请求数 */
    guestLimit: number;
    /** 登录用户在窗口期内的最大请求数 */
    authedLimit: number;
    /** 时间窗口大小（毫秒），默认 60,000ms (1分钟) */
    windowMs?: number;
}

/**
 * 在 tRPC procedure 中校验并执行滑动窗口限流。
 * - 访客：根据安全 clientIp 限流，超出抛出 429 TOO_MANY_REQUESTS。
 * - 登录用户：根据 userId 限流，超出抛出 429 TOO_MANY_REQUESTS。
 */
export const enforceProcedureRateLimit = (
    prefix: string,
    ctx: { session: AuthSession | null; isGuest: boolean; clientIp: string },
    options: ProcedureRateLimitOptions,
    limiter: SlidingWindowRateLimiter = defaultRateLimiter
): void => {
    const isAuthed = !!ctx.session;
    const key = isAuthed
        ? `${prefix}:user:${ctx.session!.userId}`
        : `${prefix}:guest:${ctx.clientIp}`;
    const limit = isAuthed ? options.authedLimit : options.guestLimit;
    const windowMs = options.windowMs ?? 60_000;

    const allowed = limiter.consume(key, limit, windowMs);
    if (!allowed) {
        throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: '请求过于频繁，请稍后再试',
        });
    }
};
