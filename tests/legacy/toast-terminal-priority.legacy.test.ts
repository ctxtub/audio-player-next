import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Toast 终态优先轻量契约测试（缺陷 #9，产品语义归档）。
 *
 * 裁决（接受现状）：过程性 toast 可被后续终态 toast 经 GlassToast 单例替换；
 * 操作快速失败时终态失败提示优先；过程提示不构成成功/失败证据。
 * 本测试仅用纯内存模型与源码静态断言，不导入真实 GlassToast，不触 DOM/网络/DB/端口，
 * 不改变 GlassToast 行为，不实现队列/最短展示时间/多 toast。
 */

// 中文注释：仓库根目录，仅用于定位被测源码路径。
const repoRoot: string = process.cwd();
// 中文注释：被测 Toast 单例源码（只读静态断言对象，不执行其 React/DOM 逻辑）。
const toastSourcePath: string = path.join(repoRoot, 'components', 'ui', 'GlassToast.tsx');
// 中文注释：Toast 配置的最小内存形态（与 GlassToast ToastConfig 同形，不引入 UI 依赖）。
type MemoryToastConfig = {
    /** 图标类型，成功或失败。 */
    icon?: 'success' | 'fail';
    /** 提示文案。 */
    content: string;
    /** 显示时长（毫秒），默认 2000。 */
    duration?: number;
};
// 中文注释：单例替换语义的纯内存模型（show 直接覆盖当前项，终态为准）。
type SingletonToastHarness = {
    /** 当前可见项（单例，无队列）。 */
    current: MemoryToastConfig | null;
    /** show 调用时间线（仅记录调用顺序，不代表多 toast 并存）。 */
    timeline: string[];
    /** 显示提示（直接替换当前项）。 */
    show: (config: MemoryToastConfig) => void;
    /** 手动关闭（置空当前项）。 */
    clear: () => void;
};

/**
 * 创建纯内存单例 Toast 模型。
 * @returns 单例语义的内存模型。
 */
function createSingletonToastHarness(): SingletonToastHarness {
    const harness: SingletonToastHarness = {
        current: null,
        timeline: [],
        show: (config: MemoryToastConfig): void => {
            harness.current = config;
            harness.timeline.push(config.content);
        },
        clear: (): void => {
            harness.current = null;
        },
    };
    return harness;
}

/**
 * 断言 GlassToast 源码保持单例替换契约。
 * @param source GlassToast.tsx 源码文本。
 */
function assertSingletonReplaceContract(source: string): void {
    assert.ok(source.includes('glass-toast-container'), 'Toast 必须使用单一容器');
    assert.ok(source.includes('clearTimeout(hideTimer)'), 'show 必须先清旧定时器再替换');
    assert.ok(source.includes('root?.render'), 'show 必须直接重渲染单例，无排队');
    assert.ok(!/queue/i.test(source), '不得引入队列语义');
    assert.ok(!/pendingToasts|toastQueue/i.test(source), '不得引入待展示队列');
    assert.ok(!/minDuration|minimumDuration/i.test(source), '不得引入最短展示时间');
}

/**
 * 用例：过程提示可被终态失败替换，终态失败优先。
 */
function caseProcessReplaceableByTerminalFail(): void {
    const harness: SingletonToastHarness = createSingletonToastHarness();
    harness.show({ content: '正在切换段落' });
    harness.show({ icon: 'fail', content: '语音生成稍有延迟，请重试' });
    assert.strictEqual(harness.current?.content, '语音生成稍有延迟，请重试', '终态失败提示必须优先');
    assert.strictEqual(harness.current?.icon, 'fail', '终态必须为失败态');
    assert.deepStrictEqual(harness.timeline, ['正在切换段落', '语音生成稍有延迟，请重试'], '调用顺序应如实记录');
}

/**
 * 用例：过程提示不构成成功/失败证据，仅终态断言为准。
 */
function caseProcessToastIsNotEvidence(): void {
    const harness: SingletonToastHarness = createSingletonToastHarness();
    harness.show({ content: '正在切换段落' });
    const interim: MemoryToastConfig | null = harness.current;
    harness.show({ icon: 'fail', content: '无法播放下一段音频' });
    assert.notStrictEqual(interim?.content, harness.current?.content, '过程项必须可被替换');
    assert.strictEqual(harness.current?.content, '无法播放下一段音频', '证据口径仅认终态项');
}

/**
 * 测试入口：串行执行契约用例。
 */
async function main(): Promise<void> {
    const source: string = readFileSync(toastSourcePath, 'utf8');
    assertSingletonReplaceContract(source);
    caseProcessReplaceableByTerminalFail();
    caseProcessToastIsNotEvidence();
}

export default main();
