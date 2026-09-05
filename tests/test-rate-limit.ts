import assert from 'node:assert';
import {
    SlidingWindowRateLimiter,
    enforceProcedureRateLimit,
} from '../lib/server/rateLimit';
import { TRPCError } from '@trpc/server';
import type { AuthSession } from '../types/auth';

async function runRateLimitTests() {
    console.log('--- 1. Testing SlidingWindowRateLimiter Core Algorithm ---');
    let currentTime = 1_000_000;
    const limiter = new SlidingWindowRateLimiter({
        windowMs: 60_000,
        maxKeys: 100,
        nowFn: () => currentTime,
    });

    // Limit of 3
    assert.strictEqual(limiter.consume('user:1', 3), true, 'Call 1 allowed');
    assert.strictEqual(limiter.consume('user:1', 3), true, 'Call 2 allowed');
    assert.strictEqual(limiter.consume('user:1', 3), true, 'Call 3 allowed');
    assert.strictEqual(limiter.consume('user:1', 3), false, 'Call 4 rejected (over limit 3)');

    const status = limiter.checkAndConsume('user:1', 3);
    assert.strictEqual(status.allowed, false, 'Status allowed should be false');
    assert.strictEqual(status.remaining, 0, 'Remaining should be 0');
    assert.strictEqual(status.resetMs, 60_000, 'Reset time should be 60s');

    // Advance time by 61 seconds (past window)
    currentTime += 61_000;
    assert.strictEqual(limiter.consume('user:1', 3), true, 'Call after window slide should be allowed');
    console.log('PASS: Sliding window consumption and time-based sliding pass');

    console.log('--- 2. Testing Bounded Memory & Capacity Protection ---');
    currentTime = 2_000_000;
    const boundedLimiter = new SlidingWindowRateLimiter({
        windowMs: 10_000,
        maxKeys: 5,
        nowFn: () => currentTime,
    });

    for (let i = 1; i <= 5; i++) {
        boundedLimiter.consume(`key:${i}`, 10);
    }
    assert.strictEqual(boundedLimiter.size, 5, 'Size should reach maxKeys (5)');

    // Add 6th key while keys 1-5 are still active -> triggers FIFO eviction
    boundedLimiter.consume('key:6', 10);
    assert(boundedLimiter.size <= 5, `Size must remain <= maxKeys (5), got ${boundedLimiter.size}`);

    // Advance time past window so all existing keys expire
    currentTime += 15_000;
    // Add key:7 -> triggers expired keys cleanup
    boundedLimiter.consume('key:7', 10);
    assert(boundedLimiter.size <= 5, 'Expired keys should be cleaned up on capacity check');
    console.log('PASS: Bounded memory ensures maxKeys invariant');

    console.log('--- 3. Testing Procedure Rate Limiter (Guest 10/min, Authed 30/min for agent) ---');
    const agentLimiter = new SlidingWindowRateLimiter({
        windowMs: 60_000,
        nowFn: () => currentTime,
    });

    const guestCtx1 = {
        session: null,
        isGuest: true,
        clientIp: '10.0.0.1',
    };
    const guestCtx2 = {
        session: null,
        isGuest: true,
        clientIp: '10.0.0.2',
    };
    const authedCtx1 = {
        session: { userId: 101, nickname: 'Alice' } as AuthSession,
        isGuest: false,
        clientIp: '10.0.0.1',
    };
    const authedCtx2 = {
        session: { userId: 102, nickname: 'Bob' } as AuthSession,
        isGuest: false,
        clientIp: '10.0.0.1',
    };

    // Agent guest: 10 allowed, 11th throws 429
    for (let i = 1; i <= 10; i++) {
        assert.doesNotThrow(() => {
            enforceProcedureRateLimit('agent:interact', guestCtx1, { guestLimit: 10, authedLimit: 30 }, agentLimiter);
        }, `Guest request ${i} should be allowed`);
    }

    assert.throws(() => {
        enforceProcedureRateLimit('agent:interact', guestCtx1, { guestLimit: 10, authedLimit: 30 }, agentLimiter);
    }, (err: unknown) => {
        return err instanceof TRPCError && err.code === 'TOO_MANY_REQUESTS';
    }, '11th guest request must throw TRPCError TOO_MANY_REQUESTS (429)');

    // Different guest IP (guestCtx2) is not affected
    assert.doesNotThrow(() => {
        enforceProcedureRateLimit('agent:interact', guestCtx2, { guestLimit: 10, authedLimit: 30 }, agentLimiter);
    }, 'Different guest IP should have its own separate quota');

    // Agent authed: 30 allowed, 31st throws 429
    for (let i = 1; i <= 30; i++) {
        assert.doesNotThrow(() => {
            enforceProcedureRateLimit('agent:interact', authedCtx1, { guestLimit: 10, authedLimit: 30 }, agentLimiter);
        }, `Authed request ${i} should be allowed`);
    }

    assert.throws(() => {
        enforceProcedureRateLimit('agent:interact', authedCtx1, { guestLimit: 10, authedLimit: 30 }, agentLimiter);
    }, (err: unknown) => {
        return err instanceof TRPCError && err.code === 'TOO_MANY_REQUESTS';
    }, '31st authed request must throw TRPCError TOO_MANY_REQUESTS (429)');

    // Different authed user (authedCtx2) on same IP is not affected
    assert.doesNotThrow(() => {
        enforceProcedureRateLimit('agent:interact', authedCtx2, { guestLimit: 10, authedLimit: 30 }, agentLimiter);
    }, 'Different authed user should have its own quota even from same IP');

    console.log('PASS: agent.interact guest 10/min and authed 30/min rate limits enforced with 429');

    console.log('--- 4. Testing Procedure Rate Limiter (Guest 15/min, Authed 45/min for tts) ---');
    const ttsLimiter = new SlidingWindowRateLimiter({
        windowMs: 60_000,
        nowFn: () => currentTime,
    });

    // TTS guest: 15 allowed, 16th throws 429
    for (let i = 1; i <= 15; i++) {
        assert.doesNotThrow(() => {
            enforceProcedureRateLimit('tts:synthesize', guestCtx1, { guestLimit: 15, authedLimit: 45 }, ttsLimiter);
        }, `TTS Guest request ${i} should be allowed`);
    }

    assert.throws(() => {
        enforceProcedureRateLimit('tts:synthesize', guestCtx1, { guestLimit: 15, authedLimit: 45 }, ttsLimiter);
    }, (err: unknown) => {
        return err instanceof TRPCError && err.code === 'TOO_MANY_REQUESTS';
    }, '16th TTS guest request must throw TRPCError TOO_MANY_REQUESTS (429)');

    // TTS authed: 45 allowed, 46th throws 429
    for (let i = 1; i <= 45; i++) {
        assert.doesNotThrow(() => {
            enforceProcedureRateLimit('tts:synthesize', authedCtx1, { guestLimit: 15, authedLimit: 45 }, ttsLimiter);
        }, `TTS Authed request ${i} should be allowed`);
    }

    assert.throws(() => {
        enforceProcedureRateLimit('tts:synthesize', authedCtx1, { guestLimit: 15, authedLimit: 45 }, ttsLimiter);
    }, (err: unknown) => {
        return err instanceof TRPCError && err.code === 'TOO_MANY_REQUESTS';
    }, '46th TTS authed request must throw TRPCError TOO_MANY_REQUESTS (429)');

    console.log('PASS: tts.synthesize guest 15/min and authed 45/min rate limits enforced with 429');
}

const testPromise = runRateLimitTests()
    .then(() => {
        console.log('ALL RATE LIMIT TESTS PASSED');
    })
    .catch((err) => {
        console.error('Test failed:', err);
        process.exit(1);
    });

export default testPromise;
