import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * R15 守卫接线 Static 迁移（任务11 STEP-1）。
 * 来源：tests/legacy/audio-ended-guard-wiring.legacy.test.ts（R15-W1 部分）。
 * 拆分：W1 接线静态锁定迁入本 Static 文件；W2/W3 行为断言已由
 * tests/unit/playback/audio-ended-guard.unit.test.ts（R15-01/R15-02）同语义覆盖，
 * 经旧位置 PASS 确认属「迁移时不得合并删断言」之已覆盖项，不新建重复 L1 文件。
 * Static 层允许源码接线锁；断言语义不变（向量保持）。
 */

/** 执行守卫接线静态锁定（R15-W1）。 */
async function runGuardWiringStaticTests(): Promise<void> {
    console.log('=== R15-W1: 守卫三处调用点接线静态锁定 ===');
    const source = readFileSync(
        path.join(process.cwd(), 'components/AudioControllerHost/index.tsx'),
        'utf8',
    );
    const idxUnlock = source.indexOf('const handleUnlock');
    const idxArm = source.indexOf('endedGuardRef.current.armForUnlock()');
    const idxSettle = source.indexOf('endedGuardRef.current.settleUnlock()');
    const idxPlay = source.indexOf('const handlePlay');
    const idxEnded = source.indexOf('const handleEnded');
    const idxSkip = source.indexOf('endedGuardRef.current.shouldSkipEnded()');
    assert.ok(idxUnlock !== -1 && idxPlay !== -1 && idxEnded !== -1, '宿主须保留 handleUnlock/handlePlay/handleEnded');
    assert.ok(idxArm !== -1, 'handleUnlock 必须调用 armForUnlock');
    assert.ok(idxSettle !== -1, 'handleUnlock finally 必须调用 settleUnlock');
    assert.ok(idxUnlock < idxArm, 'armForUnlock 必须位于 handleUnlock 内');
    assert.ok(idxArm < idxSettle && idxSettle < idxPlay, 'settleUnlock 必须在 arm 之后、handleUnlock 收尾内');
    assert.ok(idxSkip !== -1, 'handleEnded 必须调用 shouldSkipEnded');
    assert.ok(idxEnded < idxSkip, 'shouldSkipEnded 调用必须位于 handleEnded 内');
    assert.ok(
        source.slice(idxSkip, idxSkip + 200).includes('return;'),
        '命中守卫的 ended 必须直接 return（跳过业务收尾）',
    );
    console.log('PASS: R15-W1 守卫接线静态锁定 (STATIC)');
}

const testPromise = runGuardWiringStaticTests()
    .then(() => {
        console.log('ALL GUARD-WIRING STATIC TESTS PASSED SUCCESSFULLY');
    })
    .catch((err) => {
        console.error('Guard wiring static test failed:', err);
        process.exit(1);
    });

export default testPromise;
