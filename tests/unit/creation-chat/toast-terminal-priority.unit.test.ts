import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';

// 中文注释：NodeRequire 兼容取值（jiti 运行器下 require 可能未全局暴露）。
const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
// 中文注释：jsdom 最小形态（无 @types/jsdom，经 require 加载，避免新增类型依赖）。
type JSDOMWindowLike = Record<string, unknown>;
type JSDOMLike = { window: JSDOMWindowLike };
type JSDOMCtorLike = new (html: string, opts?: Record<string, unknown>) => JSDOMLike;
// 中文注释：仓库根目录，用于 inner-jiti 的 alias 解析。
const repoRoot: string = process.cwd();
// 中文注释：inner-jiti 工厂（解析真实 .tsx 组件，需 jsx:true；测试文件本身为 .ts，外层 jiti 无需 jsx）。
type JitiInstance = (id: string) => Record<string, unknown>;
type JitiFactory = (base: string, opts: Record<string, unknown>) => JitiInstance;
// 中文注释：真实 GlassToast 的最小形态（与 components/ui/GlassToast.tsx 默认导出同形）。
type RealGlassToast = {
    /** 显示提示（真实单例渲染）。 */
    show: (config: { icon?: 'success' | 'fail'; content: string; duration?: number }) => void;
    /** 手动关闭。 */
    clear: () => void;
};

/**
 * 安装样式与静态资源内存桩（仅拦截 .scss/.css/图片后缀，不触业务逻辑）。
 * 真实组件仍走完整 React 渲染，仅样式对象被桩化。
 */
function installAssetStubs(): void {
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
                },
            );
            (m as unknown as { exports: unknown }).exports = proxy;
        };
        extTable['.scss'] = scssStub as (m: NodeModule, f: string) => void;
        extTable['.css'] = scssStub as (m: NodeModule, f: string) => void;
    }
    if (extTable) {
        for (const ext of ['.jpeg', '.jpg', '.png', '.svg', '.webp', '.gif', '.avif', '.ico']) {
            if (!extTable[ext]) {
                extTable[ext] = ((m: NodeModule, f: string): void => {
                    (m as unknown as { exports: unknown }).exports = f;
                }) as (m: NodeModule, f: string) => void;
            }
        }
    }
}

/**
 * 搭建 jsdom 全局环境（document/window/navigator 缺一不可，否则真实 GlassToast 直接早退）。
 */
function setupJsdom(): JSDOMLike {
    const { JSDOM } = nodeRequire('jsdom') as unknown as { JSDOM: JSDOMCtorLike };
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://localhost/',
        pretendToBeVisual: true,
    });
    const win = dom.window as unknown as Record<string, unknown>;
    const g = globalThis as unknown as Record<string, unknown>;
    // 中文注释：Node22 原生 navigator 为只读 getter，必须 defineProperty 覆盖。
    for (const [key, value] of Object.entries({
        window: win,
        document: win.document,
        navigator: win.navigator,
        HTMLElement: win.HTMLElement,
        Node: win.Node,
        React,
    })) {
        try {
            Object.defineProperty(g, key, { value, writable: true, configurable: true });
        } catch {
            // 中文注释：兜底直接赋值（可写环境）。
            g[key] = value;
        }
    }
    g.requestAnimationFrame = (cb: () => void): unknown => setTimeout(cb, 0);
    g.cancelAnimationFrame = (id: unknown): void => {
        clearTimeout(id as NodeJS.Timeout);
    };
    return dom;
}

/**
 * 经 inner-jiti 加载真实 GlassToast（components/ui/GlassToast.tsx 默认导出）。
 * @returns 真实 GlassToast 单例。
 */
function loadRealGlassToast(): RealGlassToast {
    installAssetStubs();
    const factory = nodeRequire('jiti') as unknown as JitiFactory;
    const innerJiti = factory(path.join(repoRoot, 'index.js'), {
        alias: { '@': repoRoot },
        jsx: true,
    });
    const mod = innerJiti('./components/ui/GlassToast.tsx') as unknown as {
        default: RealGlassToast;
    };
    const toast = mod.default;
    assert.ok(toast && typeof toast.show === 'function', '真实 GlassToast 必须暴露 show');
    assert.ok(typeof toast.clear === 'function', '真实 GlassToast 必须暴露 clear');
    return toast;
}

/**
 * 等待真实 Toast 经 createRoot 渲染落盘（React 19 并发渲染需让出事件循环）。
 * @param ms 等待毫秒数。
 */
async function waitForToastRender(ms = 250): Promise<void> {
    await new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * 读取当前 document 中可见的 Toast 文案（单例容器内文本）。
 * @returns body 文本快照。
 */
function readToastBodyText(): string {
    const doc = (globalThis as unknown as { document: Document }).document;
    return doc.body.textContent ?? '';
}

async function runToastTerminalPriorityTests(): Promise<void> {
    setupJsdom();
    const GlassToast = loadRealGlassToast();

    console.log('=== TOAST-01: 过程提示可被终态失败替换（终态优先）===');
    {
        GlassToast.show({ content: '正在切换段落' });
        await waitForToastRender(200);
        const interim = readToastBodyText();
        assert.ok(interim.includes('正在切换段落'), '过程提示应先可见');
        GlassToast.show({ icon: 'fail', content: '语音生成稍有延迟，请重试' });
        await waitForToastRender(250);
        const terminal = readToastBodyText();
        assert.ok(
            terminal.includes('语音生成稍有延迟，请重试'),
            '终态失败提示必须优先可见',
        );
        assert.ok(!terminal.includes('正在切换段落'), '过程提示必须被单例替换（不共存）');
        const containerCount = (globalThis as unknown as { document: Document }).document.querySelectorAll(
            '#glass-toast-container',
        ).length;
        assert.strictEqual(containerCount, 1, '必须保持单一容器（单例语义，无队列）');
    }
    console.log('PASS: TOAST-01 终态失败替换过程提示');

    console.log('=== TOAST-02: 过程提示不构成成功/失败证据，仅终态为准 ===');
    {
        GlassToast.show({ content: '正在切换段落' });
        await waitForToastRender(200);
        const interim = readToastBodyText();
        GlassToast.show({ icon: 'fail', content: '无法播放下一段音频' });
        await waitForToastRender(250);
        const terminal = readToastBodyText();
        assert.notStrictEqual(interim, terminal, '过程项必须可被替换');
        assert.ok(terminal.includes('无法播放下一段音频'), '证据口径仅认终态项');
    }
    console.log('PASS: TOAST-02 过程提示非证据');

    console.log('=== TOAST-03: 真实单例契约（show 直接重渲染、无排队）===');
    {
        // 中文注释：连续两次 show 必须以后者为准（覆盖 clearTimeout+重渲染语义的行为侧断言）。
        GlassToast.show({ icon: 'success', content: '第一条终态' });
        GlassToast.show({ icon: 'fail', content: '第二条终态' });
        await waitForToastRender(250);
        const body = readToastBodyText();
        assert.ok(body.includes('第二条终态'), '后一次 show 必须覆盖前一次');
        assert.ok(!body.includes('第一条终态'), '不得出现两条并存（无队列）');
        GlassToast.clear();
        await waitForToastRender(150);
    }
    console.log('PASS: TOAST-03 单例覆盖契约');

    console.log('\nALL TOAST TERMINAL PRIORITY TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runToastTerminalPriorityTests()
    .then(() => {
        console.log('ALL TOAST TERMINAL PRIORITY TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Toast terminal priority test failed:', error);
        process.exit(1);
    });

export default testPromise;
