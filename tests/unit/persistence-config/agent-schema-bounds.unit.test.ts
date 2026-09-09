import assert from 'node:assert';
import { interactSchema } from '../../../lib/trpc/schemas/agent';

/**
 * Agent Schema 边界行为测试（任务11 STEP-1，L1）。
 * 来源：tests/legacy/batch-source-locks.legacy.test.ts 中 SEC-03 运行时部分。
 * 拆分：源码文本锁（.max 字符串）留 tests/static/batch-source-locks.static.test.ts；
 * 本文件仅收容连接真实导出的运行时行为（safeParse），无源码字符串锁。
 * 旧位置已 PASS（基线），新位置 PASS 即向量保持。
 */

/** 执行 schema 边界行为断言。 */
async function runAgentSchemaBoundsTests(): Promise<void> {
    console.log('=== SEC-03-BEHAVIOR: 合法载荷通过 ===');
    // 中文注释：合法单条消息应通过真实 interactSchema。
    const valid = interactSchema.safeParse({
        messages: [{ role: 'user', content: 'hello' }],
    });
    assert.strictEqual(valid.success, true, 'SEC-03: Valid message should pass');
    console.log('PASS: SEC-03 valid payload');

    console.log('=== SEC-03-BEHAVIOR: 超 100 条拒绝 ===');
    // 中文注释：101 条消息应被 .max(100) 拒绝。
    const tooManyMessages = Array.from({ length: 101 }, () => ({ role: 'user' as const, content: 'msg' }));
    const rejectTooMany = interactSchema.safeParse({ messages: tooManyMessages });
    assert.strictEqual(rejectTooMany.success, false, 'SEC-03: >100 messages should be rejected');
    console.log('PASS: SEC-03 too many rejected');

    console.log('=== SEC-03-BEHAVIOR: 超 10000 字拒绝 ===');
    // 中文注释：单条超长内容应被 .max(10000) 拒绝。
    const rejectTooLong = interactSchema.safeParse({
        messages: [{ role: 'user', content: 'a'.repeat(10001) }],
    });
    assert.strictEqual(rejectTooLong.success, false, 'SEC-03: >10000 chars should be rejected');
    console.log('PASS: SEC-03 too long rejected');

    console.log('ALL AGENT-SCHEMA-BOUNDS TESTS PASSED SUCCESSFULLY');
}

const testPromise = runAgentSchemaBoundsTests()
    .then(() => {
        console.log('ALL AGENT-SCHEMA-BOUNDS TESTS PASSED SUCCESSFULLY');
    })
    .catch((err) => {
        console.error('Agent schema bounds test failed:', err);
        process.exit(1);
    });

export default testPromise;
