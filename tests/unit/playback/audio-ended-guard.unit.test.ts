import assert from 'node:assert';
import { createAudioEndedGuard } from '../../../utils/audioEndedGuard';

/**
 * R15 回归：解锁残留标记不得吞掉首个真实 ended。
 *
 * 生命周期建模（与 AudioControllerHost.handleUnlock/handleEnded 一致）：
 * 解锁开始置位 → 解锁内 play() 后同步 pause()（无 ended 产生）→ settled →
 * 首个真实内容 ended 到达，必须被处理（不得跳过）。
 */
async function runAudioEndedGuardTests() {
    console.log('=== R15-01: 解锁 settled 后首个真实 ended 不得被吞 ===');
    const guard1 = createAudioEndedGuard();
    guard1.armForUnlock();
    // 中文注释：解锁内无 ended（play 后同步 pause），直接 settled。
    guard1.settleUnlock();
    assert.strictEqual(
        guard1.shouldSkipEnded(),
        false,
        '首个真实 ended 必须被处理（旧行为返回 true，即被吞掉）',
    );
    console.log('PASS: R15-01 verified');

    console.log('=== R15-02: 置位窗口内的 ended 仍只跳过一次 ===');
    const guard2 = createAudioEndedGuard();
    guard2.armForUnlock();
    assert.strictEqual(guard2.shouldSkipEnded(), true, '窗口内首个 ended 应被跳过');
    assert.strictEqual(guard2.shouldSkipEnded(), false, '标记消费后后续 ended 必须处理');
    console.log('PASS: R15-02 verified');

    console.log('=== R15-03: 未置位时 ended 恒被处理 ===');
    const guard3 = createAudioEndedGuard();
    assert.strictEqual(guard3.shouldSkipEnded(), false, '未置位不得跳过');
    console.log('PASS: R15-03 verified');

    console.log('\nALL AUDIO-ENDED-GUARD TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runAudioEndedGuardTests()
    .then(() => {
        console.log('ALL AUDIO-ENDED-GUARD TEST CASES PASSED SUCCESSFULLY!');
    })
    .catch((err) => {
        console.error('Test execution failed:', err);
        process.exit(1);
    });

export default testPromise;
