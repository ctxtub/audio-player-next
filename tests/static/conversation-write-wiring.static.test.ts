import assert from 'node:assert';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * 会话写入接线 Static 迁移（任务11 STEP-3）。
 * 来源：tests/legacy/conversation-write-wiring.legacy.test.ts 中 H-15-WIRING-01 部分。
 * 拆分：本文件仅收容纯源码接线静态锁定（router/client/store 文本锁 6 条）；
 * 运行时行为（W00 schema 透传、W02 真并发竞速、W03 旧调用兼容、W04 客户端 CONFLICT 刷新）
 * 已拆至 tests/integration/persistence-config/conversation-conflict-refresh.integration.test.ts（真实 DB + 真实 store）。
 * Static 层允许文本锁；断言语义与旧位置逐字一致（向量保持）。
 */

/** 执行会话写入接线静态锁定（H-15-WIRING-01）。 */
async function runConversationWriteWiringStaticTests(): Promise<void> {
    console.log('=== H-15-WIRING-01: 接线静态锁定（router/client/store）===');
    const routerSource = readFileSync(path.join(process.cwd(), 'lib', 'trpc', 'routers', 'chatConversation.ts'), 'utf8');
    assert.ok(routerSource.includes('baseMessageIds'), 'RED: router 必须透传 baseMessageIds');
    assert.ok(routerSource.includes('expectedMessageIds'), 'RED: router 必须映射为 expectedMessageIds');
    const clientSource = readFileSync(path.join(process.cwd(), 'lib', 'client', 'chatConversation.ts'), 'utf8');
    assert.ok(clientSource.includes('baseMessageIds'), 'RED: client saveMyConversation 必须接受 baseMessageIds');
    const storeSource = readFileSync(path.join(process.cwd(), 'stores', 'chatStore.ts'), 'utf8');
    assert.ok(storeSource.includes('CONFLICT'), 'RED: store 必须处理 CONFLICT');
    assert.ok(storeSource.includes('会话已被其它标签页更新，已刷新'), 'RED: store CONFLICT toast 文案不得漂移');
    assert.ok(storeSource.includes('GlassToast'), 'RED: store CONFLICT 必须经 GlassToast 提示');
    console.log('PASS: H-15-WIRING-01 wiring locked (STATIC)');
    console.log('\nALL CONVERSATION-WRITE-WIRING STATIC TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runConversationWriteWiringStaticTests()
    .then(() => {
        console.log('ALL CONVERSATION-WRITE-WIRING STATIC TESTS PASSED SUCCESSFULLY!');
    })
    .catch((err) => {
        console.error('Conversation write wiring static test failed:', err);
        process.exit(1);
    });

export default testPromise;
