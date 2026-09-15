import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 中文注释：M7-03 Sleep Timer Control/VM 单测（L1，纯函数 + 架构守卫，不触库/网络）。
// 锁定验收 5/7/8/9/10 的确定性切面：Control 展示模型（§32）、自定义合法性、
// ViewModel 三态派生（§22/§32，非法 fail-closed）、Draft 门（§22.1）、
// UI 只经 flow 命令（约束 10）、Escape 内联消费（约束 9）、
// Settings 默认区 10–120 step 10（§29）。

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

const readRepoText = (rel: string): string =>
    fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const loadViaJiti = (rel: string): Record<string, unknown> => {
    const factory = nodeRequire('jiti') as unknown as (
        base: string,
        opts: Record<string, unknown>
    ) => (id: string) => Record<string, unknown>;
    const inner = factory(path.join(process.cwd(), 'index.js'), {
        alias: { '@': process.cwd() },
        jsx: true,
    });
    return inner(rel.startsWith('./') || rel.startsWith('../') ? rel : `./${rel}`);
};

const installUnitStubs = (): void => {
    const extTable = (
        nodeRequire as unknown as {
            extensions: Record<string, (m: NodeModule, f: string) => void>;
        }
    ).extensions;
    if (extTable && !extTable['.scss']) {
        const scssStub = (m: NodeModule): void => {
            const proxy = new Proxy(
                {},
                {
                    get: (_t: object, p: string | symbol): unknown => {
                        if (p === '__esModule') {
                            return true;
                        }
                        return String(p);
                    },
                }
            );
            (m as unknown as { exports: unknown }).exports = proxy;
        };
        extTable['.scss'] = scssStub as (m: NodeModule, f: string) => void;
        extTable['.css'] = scssStub as (m: NodeModule, f: string) => void;
    }
};

const stripComments = (src: string): string =>
    src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/.*$/gm, '$1');

async function runSleepTimerControlUnit(): Promise<void> {
    installUnitStubs();

    console.log('=== M7-03-U1: Control 展示模型（§32） ===');
    {
        const mod = loadViaJiti('./components/NowPlaying/SleepTimerControl.tsx') as unknown as {
            deriveSleepTimerControlModel: (
                mode: unknown,
                remainingMs: unknown,
                isWork: boolean,
            ) => { displayLabel: string; ariaLabel: string; showStoryEnd: boolean };
            isValidCustomSleepTimerMinutes: (value: number) => boolean;
        };
        const off = mod.deriveSleepTimerControlModel('off', null, true);
        assert.strictEqual(off.displayLabel, '睡眠定时 · 关闭');
        assert.strictEqual(off.showStoryEnd, true, 'Work 显示 story_end');
        const draftOff = mod.deriveSleepTimerControlModel('off', null, false);
        assert.strictEqual(draftOff.showStoryEnd, false, 'Draft 隐藏 story_end（§22.1）');
        const minutes = mod.deriveSleepTimerControlModel('minutes', 1800000, false);
        assert.strictEqual(minutes.displayLabel, '30:00 后暂停');
        assert.strictEqual(minutes.showStoryEnd, false);
        const storyEnd = mod.deriveSleepTimerControlModel('story_end', null, true);
        assert.strictEqual(storyEnd.displayLabel, '本故事结束后');
        assert.strictEqual(mod.isValidCustomSleepTimerMinutes(10), true);
        assert.strictEqual(mod.isValidCustomSleepTimerMinutes(120), true);
        assert.strictEqual(mod.isValidCustomSleepTimerMinutes(9), false);
        assert.strictEqual(mod.isValidCustomSleepTimerMinutes(121), false);
        assert.strictEqual(mod.isValidCustomSleepTimerMinutes(30.5), false);
        console.log('PASS: M7-03-U1 control model');
    }

    console.log('=== M7-03-U2: ViewModel 三态派生（§22/§32） ===');
    {
        const mod = loadViaJiti('./components/NowPlaying/useExpandedNowPlayingViewModel.ts') as unknown as {
            deriveExpandedSleepTimer: (
                mode: unknown,
                remainingMs: unknown,
                source: { kind: string } | null,
            ) => { mode: string; remainingMs: number | null; isWork: boolean };
            deriveExpandedNowPlayingViewModel: (
                session: Record<string, unknown>,
                transport: Record<string, unknown>,
                voiceOptions: unknown[],
            ) => { sleepTimer: { mode: string; remainingMs: number | null; isWork: boolean } };
        };
        assert.deepStrictEqual(mod.deriveExpandedSleepTimer('minutes', 600000, { kind: 'work' }), {
            mode: 'minutes',
            remainingMs: 600000,
            isWork: true,
        });
        assert.deepStrictEqual(mod.deriveExpandedSleepTimer('story_end', null, { kind: 'work' }), {
            mode: 'story_end',
            remainingMs: null,
            isWork: true,
        });
        assert.deepStrictEqual(mod.deriveExpandedSleepTimer('bogus', 600000, { kind: 'draft' }), {
            mode: 'off',
            remainingMs: null,
            isWork: false,
        }, '非法 mode fail-closed off');
        assert.deepStrictEqual(mod.deriveExpandedSleepTimer('minutes', 0, { kind: 'work' }).remainingMs, null);
        // 总装向后兼容：旧快照（无 timer 字段）→ off/null。
        const vm = mod.deriveExpandedNowPlayingViewModel(
            { source: { kind: 'draft' }, status: 'paused', title: 't', voiceId: '', nextParagraphIndex: 0, totalParagraphs: 1 },
            { isPlaying: false, currentTime: 0, duration: 0 },
            [],
        );
        assert.deepStrictEqual(vm.sleepTimer, { mode: 'off', remainingMs: null, isWork: false });
        console.log('PASS: M7-03-U2 viewmodel');
    }

    console.log('=== M7-03-U3: UI 命令面守卫（约束 9/10 + §29/§31.1） ===');
    {
        // 约束 10：Expanded Timer 选择唯一经 facade.setSleepTimer → flow。
        const facadeSrc = stripComments(readRepoText('components/NowPlaying/useExpandedPlaybackControls.ts'));
        assert.ok(facadeSrc.includes('setSleepTimer'), 'facade 必须暴露 setSleepTimer');
        assert.ok(facadeSrc.includes('flowSetSleepTimer'), 'facade 必须委托 flow.setSleepTimer');
        assert.ok(!facadeSrc.includes('usePlaybackSessionStore'), 'facade 不得直写 Session（M5 ownership）');
        assert.ok(!facadeSrc.includes('usePlaybackStore'), 'facade 不得直写 Transport');
        const flowSrc = stripComments(readRepoText('app/services/playbackSessionFlow.ts'));
        assert.ok(flowSrc.includes('setSleepTimer'), 'flow 必须有 setSleepTimer 编排');
        // Expanded 渲染 SleepTimerControl（受控：mode/remaining/isWork/onSelect）。
        const expandedSrc = stripComments(readRepoText('components/NowPlaying/ExpandedNowPlaying.tsx'));
        assert.ok(expandedSrc.includes('SleepTimerControl'), 'Expanded 必须渲染 SleepTimerControl');
        assert.ok(expandedSrc.includes('viewModel.sleepTimer.mode'), 'mode 来自 ViewModel');
        assert.ok(expandedSrc.includes('controls.setSleepTimer'), '选择走 facade');
        // 约束 9：内联菜单 + Escape stopPropagation（无 portal ownership 争议）。
        const controlSrc = stripComments(readRepoText('components/NowPlaying/SleepTimerControl.tsx'));
        assert.ok(controlSrc.includes("stopPropagation"), 'Escape 必须 stopPropagation（RAC Dialog 不连带关闭）');
        assert.ok(!controlSrc.includes('createPortal'), '不得 portal（内联形态）');
        for (const testid of [
            'expanded-sleep-timer-pill',
            'expanded-sleep-timer-menu',
            'expanded-sleep-timer-option-off',
            'expanded-sleep-timer-custom',
            'expanded-sleep-timer-custom-input',
            'expanded-sleep-timer-custom-apply',
            'expanded-sleep-timer-option-story_end',
        ]) {
            assert.ok(controlSrc.includes(testid), `Control 必须含 ${testid}`);
        }
        // 预设 10/20/30/60 经模板 `expanded-sleep-timer-option-${preset}` 生成，
        // 数据源为 SSOT SLEEP_TIMER_PRESET_MINUTES。
        assert.ok(controlSrc.includes('expanded-sleep-timer-option-${preset}'), '预设选项须经模板生成');
        assert.ok(controlSrc.includes('SLEEP_TIMER_PRESET_MINUTES'), '预设须走 SSOT');
        // §29/§31：Settings 默认区（开关 + 10–120 step 10），旧 10–60 区移除。
        const sectionSrc = stripComments(readRepoText('app/(main)/setting/components/DefaultSleepTimerSection.tsx'));
        assert.ok(sectionSrc.includes('SLEEP_TIMER_MIN_MINUTES'), '分钟下限走 SSOT');
        assert.ok(sectionSrc.includes('SLEEP_TIMER_MAX_MINUTES'), '分钟上限走 SSOT');
        assert.ok(sectionSrc.includes('SLEEP_TIMER_STEP_MINUTES'), 'step 10 走 SSOT');
        assert.ok(sectionSrc.includes('GlassSwitch'), '开关组件');
        assert.ok(!fs.existsSync(path.resolve(process.cwd(), 'app/(main)/setting/components/BasicConfigSection.tsx')), '旧 BasicConfigSection 必须移除（10–60 不一致收口）');
        const settingSrc = stripComments(readRepoText('app/(main)/setting/index.tsx'));
        assert.ok(settingSrc.includes('DefaultSleepTimerSection'), '设置页必须挂载 DefaultSleepTimerSection');
        assert.ok(settingSrc.includes('defaultSleepTimerEnabled'), '设置页读写新 enabled 字段');
        assert.ok(settingSrc.includes('defaultSleepTimerMinutes'), '设置页读写新 minutes 字段');
        console.log('PASS: M7-03-U3 command surface guards');
    }

    console.log('\nALL M7-03 SLEEP TIMER CONTROL UNIT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runSleepTimerControlUnit()
    .then(() => {
        console.log('ALL M7-03 SLEEP TIMER CONTROL UNIT TESTS PASSED SUCCESSFULLY!');
    })
    .catch((err) => {
        console.error('Test execution failed:', err);
        process.exit(1);
    });

export default testPromise;
