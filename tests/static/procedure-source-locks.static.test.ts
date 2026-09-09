import fs from 'fs';
import assert from 'assert';

/**
 * 过程源码锁 Static 迁移（任务11 STEP-1）。
 * 来源：tests/legacy/procedure-source-locks.legacy.test.ts（原 test-sec-02）。
 * 整体迁移后原 legacy 文件删除；断言语义不变（向量保持）。
 * Static 层允许源码文本锁。
 */

// 中文注释：被测源码文本（agent 与 tts 路由的过程类型锁）。
const agentContent = fs.readFileSync('lib/trpc/routers/agent.ts', 'utf-8');
const ttsContent = fs.readFileSync('lib/trpc/routers/tts.ts', 'utf-8');

assert(!agentContent.includes('interact: publicProcedure'), 'SEC-02: agent.interact should not be publicProcedure');
assert(agentContent.includes('interact: guardedProcedure'), 'SEC-02: agent.interact should be guardedProcedure');

assert(!ttsContent.includes('synthesize: publicProcedure'), 'SEC-02: tts.synthesize should not be publicProcedure');
assert(ttsContent.includes('synthesize: guardedProcedure'), 'SEC-02: tts.synthesize should be guardedProcedure');

console.log('SEC-02: PASS (STATIC)');
