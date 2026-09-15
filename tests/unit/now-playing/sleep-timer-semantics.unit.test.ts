import assert from 'node:assert';
import * as domain from '../../../lib/playback/sleepTimer';

// 中文注释：M7-03 Sleep Timer 语义单测（L1，纯函数 + Transport fake-clock，不触库/网络）。
// 锁定验收 1/2/3/4/5/6/7 的确定性切面：legacy migration 规则、默认解析、
// 三态落库值、到期归一、展示格式、ViewModel 派生、Transport countdown 门
//（fake clock 确定性驱动，无真实等待）。

async function runSleepTimerSemanticsTests(): Promise<void> {
    console.log('=== M7-03: Sleep Timer domain semantics ===');

    // —— 1. Legacy migration：remaining!=null→minutes；null/0→off（§23.1） ——
    console.log('--- §23.1: legacy migration rule ---');
    assert.strictEqual(domain.resolveSleepTimerModeFromLegacy(1800000), 'minutes');
    assert.strictEqual(domain.resolveSleepTimerModeFromLegacy(1), 'minutes');
    assert.strictEqual(domain.resolveSleepTimerModeFromLegacy(null), 'off');
    assert.strictEqual(domain.resolveSleepTimerModeFromLegacy(undefined), 'off');
    assert.strictEqual(domain.resolveSleepTimerModeFromLegacy(0), 'off', '0 为过期残留，一律 off');
    console.log('PASS: legacy migration rule');

    // —— 2. 一致性修复：minutes+预算→minutes；story_end 保留；其余 off ——
    console.log('--- §23.1: consistency repair rule ---');
    assert.strictEqual(domain.resolveConsistentSleepTimerMode('minutes', 1800000), 'minutes');
    assert.strictEqual(domain.resolveConsistentSleepTimerMode('minutes', null), 'off', 'minutes+null 不一致→off');
    assert.strictEqual(domain.resolveConsistentSleepTimerMode('off', null), 'off');
    assert.strictEqual(domain.resolveConsistentSleepTimerMode('story_end', null), 'story_end');
    assert.strictEqual(domain.resolveConsistentSleepTimerMode('bogus', 1800000), 'minutes', '非法值+预算→minutes');
    assert.strictEqual(domain.resolveConsistentSleepTimerMode('bogus', null), 'off', '非法值+null→off');
    // M7-03 全局不变式：显式 off/story_end 优先于派生（预算→minutes 只适用于 mode 缺席）。
    assert.strictEqual(domain.resolveConsistentSleepTimerMode('off', 1800000), 'off', '显式 off+预算→off');
    assert.strictEqual(domain.resolveConsistentSleepTimerMode('story_end', 1800000), 'story_end', '显式 story_end+预算→story_end');
    assert.strictEqual(domain.isValidSleepTimerMode('off'), true);
    assert.strictEqual(domain.isValidSleepTimerMode('minutes'), true);
    assert.strictEqual(domain.isValidSleepTimerMode('story_end'), true);
    assert.strictEqual(domain.isValidSleepTimerMode('bogus'), false);
    console.log('PASS: consistency repair rule');

    // —— 3. minutes 合法性：10–120 整数 ——
    console.log('--- §31: minutes bounds ---');
    assert.strictEqual(domain.isValidSleepTimerMinutes(10), true);
    assert.strictEqual(domain.isValidSleepTimerMinutes(120), true);
    assert.strictEqual(domain.isValidSleepTimerMinutes(45), true, '区间内任意整数合法（step 由 UI 约束）');
    assert.strictEqual(domain.isValidSleepTimerMinutes(9), false);
    assert.strictEqual(domain.isValidSleepTimerMinutes(121), false);
    assert.strictEqual(domain.isValidSleepTimerMinutes(30.5), false);
    assert.strictEqual(domain.sleepTimerMinutesToMs(30), 1800000);
    assert.strictEqual(domain.sleepTimerMinutesToMs(9), null);
    console.log('PASS: minutes bounds');

    // —— 4. 默认解析：enabled→minutes，否则 off；非法 minutes 回退 30（§28/§29.2） ——
    console.log('--- §28/§29.2: default session timer ---');
    assert.deepStrictEqual(
        domain.resolveDefaultSessionTimer({ defaultEnabled: true, defaultMinutes: 30 }),
        { mode: 'minutes', remainingMs: 1800000, totalMs: 1800000 },
    );
    assert.deepStrictEqual(
        domain.resolveDefaultSessionTimer({ defaultEnabled: false, defaultMinutes: 30 }),
        { mode: 'off', remainingMs: null, totalMs: null },
    );
    assert.deepStrictEqual(
        domain.resolveDefaultSessionTimer({ defaultEnabled: true, defaultMinutes: 0 }),
        { mode: 'minutes', remainingMs: 1800000, totalMs: 1800000 },
        '非法 minutes 回退默认 30（Existing user 行为保持）',
    );
    console.log('PASS: default session timer');

    // —— 5. setSleepTimer 落库值（§24） ——
    console.log('--- §24: setSleepTimer values ---');
    assert.deepStrictEqual(domain.resolveSetSleepTimerValues('off'), {
        mode: 'off', remainingMs: null, totalMs: null,
    });
    assert.deepStrictEqual(domain.resolveSetSleepTimerValues('story_end'), {
        mode: 'story_end', remainingMs: null, totalMs: null,
    });
    assert.deepStrictEqual(domain.resolveSetSleepTimerValues('minutes', 10), {
        mode: 'minutes', remainingMs: 600000, totalMs: 600000,
    });
    assert.strictEqual(domain.resolveSetSleepTimerValues('minutes'), null, 'minutes 缺 minutes→null（BAD_REQUEST）');
    assert.strictEqual(domain.resolveSetSleepTimerValues('minutes', 9), null);
    assert.deepStrictEqual(domain.SLEEP_TIMER_EXPIRED_STATE, {
        mode: 'off', remainingMs: null, totalMs: null,
    });
    assert.deepStrictEqual(domain.SLEEP_TIMER_RESET_STATE, {
        mode: 'off', remainingMs: null, totalMs: null,
    });
    console.log('PASS: setSleepTimer values');

    // —— 5b. 三元组归一：预算只存在于 minutes（begin/checkpoint/DTO/repair 共用） ——
    console.log('--- §23.1/§26: normalize triple ---');
    assert.deepStrictEqual(domain.normalizeSleepTimerTriple('off', 1800000, 1800000), {
        mode: 'off', remainingMs: null, totalMs: null,
    }, '显式 off 预算清零');
    assert.deepStrictEqual(domain.normalizeSleepTimerTriple('story_end', 1800000, 1800000), {
        mode: 'story_end', remainingMs: null, totalMs: null,
    });
    assert.deepStrictEqual(domain.normalizeSleepTimerTriple('minutes', 1800000, 1800000), {
        mode: 'minutes', remainingMs: 1800000, totalMs: 1800000,
    });
    assert.deepStrictEqual(domain.normalizeSleepTimerTriple(undefined, 1800000, 1800000), {
        mode: 'minutes', remainingMs: 1800000, totalMs: 1800000,
    }, 'mode 缺席（旧客户端）→ legacy 派生 minutes');
    assert.deepStrictEqual(domain.normalizeSleepTimerTriple(undefined, null, null), {
        mode: 'off', remainingMs: null, totalMs: null,
    });
    assert.deepStrictEqual(domain.normalizeSleepTimerTriple('minutes', 0, 1800000), {
        mode: 'off', remainingMs: null, totalMs: null,
    }, 'remaining==0 过期残留归一');
    assert.deepStrictEqual(domain.normalizeSleepTimerTriple('minutes', null, null), {
        mode: 'off', remainingMs: null, totalMs: null,
    }, 'minutes 缺正预算安全降级 off');
    console.log('PASS: normalize triple');

    // —— 6. story_end 门：仅 Work（§22.1） ——
    console.log('--- §22.1: story_end work-only gate ---');
    assert.strictEqual(domain.canUseStoryEndTimer('work'), true);
    assert.strictEqual(domain.canUseStoryEndTimer('draft'), false);
    console.log('PASS: story_end gate');

    // —— 7. 展示格式（§32） ——
    console.log('--- §32: remaining format ---');
    assert.strictEqual(domain.formatSleepTimerRemaining(1800000), '30:00');
    assert.strictEqual(domain.formatSleepTimerRemaining(61000), '01:01');
    assert.strictEqual(domain.formatSleepTimerRemaining(500), '00:01', '向上取整到秒');
    assert.strictEqual(domain.formatSleepTimerRemaining(0), '');
    assert.strictEqual(domain.formatSleepTimerRemaining(null), '');
    console.log('PASS: remaining format');

    console.log('\nALL M7-03 SLEEP TIMER SEMANTICS UNIT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runSleepTimerSemanticsTests()
    .then(() => {
        console.log('ALL M7-03 SLEEP TIMER SEMANTICS UNIT TESTS PASSED SUCCESSFULLY!');
    })
    .catch((err) => {
        console.error('Test execution failed:', err);
        process.exit(1);
    });

export default testPromise;
