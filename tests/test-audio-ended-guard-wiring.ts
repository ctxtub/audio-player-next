import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createAudioEndedGuard } from '../utils/audioEndedGuard';

/**
 * R15 守卫接线集成锁：AudioControllerHost 对
 * armForUnlock / settleUnlock / shouldSkipEnded 的接线不得静默脱落。
 *
 * 取舍（见 commit message）：组件级渲染测试需 DOM + audio 元素 mock，
 * 在 jiti/node 运行器下成本过高；抽取接线函数重构行为风险大。
 * 采用改动最小、绑定最强的方案——源码级静态断言锁三处调用点
 * 位于正确函数内且顺序正确 + 按宿主真实调用序列驱动守卫行为。
 * 接线缺失（如删掉任一调用）时本测试失败（RED 已验证）。
 */
async function runGuardWiringTests() {
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
    console.log('PASS: R15-W1 守卫接线静态锁定');

    console.log('=== R15-W2: 宿主解锁序列 arm→settle 后首个 ended 必须被处理 ===');
    {
        // 中文注释：复刻 handleUnlock 真实序列——arm 后 play→pause（无 ended）→ finally settle。
        const guard = createAudioEndedGuard();
        guard.armForUnlock();
        guard.settleUnlock();
        assert.strictEqual(guard.shouldSkipEnded(), false, 'settled 后首个真实 ended 不得被吞');
    }
    console.log('PASS: R15-W2 解锁后首个 ended 被处理');

    console.log('=== R15-W3: 解锁窗口内静音 ended 恰好跳过一次 ===');
    {
        // 中文注释：若静音片段 ended 在 settle 前到达（窗口内），只跳过一次。
        const guard = createAudioEndedGuard();
        guard.armForUnlock();
        assert.strictEqual(guard.shouldSkipEnded(), true, '窗口内首个 ended 应被跳过');
        assert.strictEqual(guard.shouldSkipEnded(), false, '标记消费后后续 ended 必须处理（恰好一次）');
    }
    console.log('PASS: R15-W3 窗口内 ended 恰好跳过一次');
}

const testPromise = runGuardWiringTests()
    .then(() => {
        console.log('ALL GUARD-WIRING TESTS PASSED SUCCESSFULLY');
    })
    .catch((err) => {
        console.error('Guard wiring test failed:', err);
        process.exit(1);
    });

export default testPromise;
