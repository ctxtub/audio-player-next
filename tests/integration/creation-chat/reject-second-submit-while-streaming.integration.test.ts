import assert from 'node:assert';
import path from 'node:path';
import { readFileSync } from 'node:fs';
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
// 中文注释：inner-jiti 实例与工厂类型（解析真实 .tsx 组件，需 jsx:true）。
type JitiInstance = (id: string) => Record<string, unknown>;
type JitiFactory = (base: string, opts: Record<string, unknown>) => JitiInstance;
// 中文注释：真实 Composer 入参与 chatStore 最小形态。
type ComposerPropsLike = {
    value?: string;
    onChange?: (v: string) => void;
    onSubmit: (c: string) => Promise<void> | void;
    disabled?: boolean;
    isSending?: boolean;
};
type ChatStoreLike = {
    getState: () => {
        messages: Array<{ role: string; status?: string }>;
        dispatch: (action: unknown) => void;
        reset: () => void;
    };
    setState: (p: Record<string, unknown>) => void;
};

/**
 * 安装样式与静态资源内存桩（仅拦截样式/图片后缀，不触业务逻辑）。
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
                    const mockImage = { src: f, width: 64, height: 64 };
                    (m as unknown as { exports: unknown }).exports = mockImage;
                }) as (m: NodeModule, f: string) => void;
            }
        }
    }
}

/**
 * 搭建 jsdom 完整全局（react-aria 按压链路需 NodeFilter/SVGElement 等）。
 * @returns jsdom 实例。
 */
function setupJsdom(): JSDOMLike {
    const { JSDOM } = nodeRequire('jsdom') as unknown as { JSDOM: JSDOMCtorLike };
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://localhost/',
        pretendToBeVisual: true,
    });
    const win = dom.window as unknown as Record<string, unknown>;
    const g = globalThis as unknown as Record<string, unknown>;
    try {
        Object.defineProperty(g, 'window', { value: win, writable: true, configurable: true });
    } catch {
        g.window = win;
    }
    const copyKeys = [
        'document',
        'navigator',
        'HTMLElement',
        'HTMLTextAreaElement',
        'Element',
        'Node',
        'Text',
        'DocumentFragment',
        'Event',
        'CustomEvent',
        'MouseEvent',
        'KeyboardEvent',
        'SVGElement',
        'NodeFilter',
        'MutationObserver',
        'getComputedStyle',
        'React',
    ];
    for (const key of copyKeys) {
        let value: unknown = key === 'React' ? React : (win as Record<string, unknown>)[key];
        if (key === 'getComputedStyle' && typeof value === 'function') {
            value = (value as (e: unknown) => unknown).bind(win);
        }
        if (value === undefined) {
            continue;
        }
        try {
            Object.defineProperty(g, key, { value, writable: true, configurable: true });
        } catch {
            g[key] = value;
        }
    }
    if (!g.SVGElement) {
        g.SVGElement = class {} as unknown;
    }
    if (!g.NodeFilter) {
        g.NodeFilter = { SHOW_ALL: 4294967295, SHOW_ELEMENT: 1 };
    }
    const matchMediaStub = (): unknown => ({
        matches: false,
        addListener: (): void => {},
        removeListener: (): void => {},
        addEventListener: (): void => {},
        removeEventListener: (): void => {},
    });
    try {
        Object.defineProperty(win, 'matchMedia', { value: matchMediaStub, writable: true, configurable: true });
    } catch {
        win.matchMedia = matchMediaStub;
    }
    g.matchMedia = matchMediaStub;
    g.requestAnimationFrame = (cb: () => void): unknown => setTimeout(cb, 0);
    g.cancelAnimationFrame = (id: unknown): void => {
        clearTimeout(id as NodeJS.Timeout);
    };
    g.IS_REACT_ACT_ENVIRONMENT = true;
    const proto = (win.Element as unknown as { prototype: Record<string, unknown> })?.prototype;
    if (proto && !proto.scrollIntoView) {
        proto.scrollIntoView = (): void => {};
    }
    return dom;
}

/**
 * 查找真实 Composer 渲染出的发送按钮与输入框。
 * 流式中 GlassButton 切 loading（spinner 替代文案），按文本找不到时退化按顺序取第二个按钮。
 * @returns 发送按钮与输入框元素。
 */
function queryComposerNodes(): { sendButton: HTMLElement; textarea: HTMLTextAreaElement } {
    const doc = (globalThis as unknown as { document: Document }).document;
    const buttons = Array.from(doc.querySelectorAll('button'));
    assert.ok(buttons.length >= 2, '真实 Composer 必须渲染出清空/发送两个按钮');
    const byText = buttons.find((b) => (b.textContent ?? '').includes('发送')) as unknown as
        | HTMLElement
        | undefined;
    // 中文注释：loading 态按钮文案被 spinner 替换，退化取第二个按钮（发送位）。
    const sendButton = (byText ?? buttons[1]) as unknown as HTMLElement;
    const textarea = doc.querySelector('textarea') as unknown as HTMLTextAreaElement | null;
    assert.ok(sendButton, '真实 Composer 必须渲染出发送按钮');
    assert.ok(textarea, '真实 Composer 必须渲染出输入框');
    return { sendButton: sendButton as HTMLElement, textarea: textarea as HTMLTextAreaElement };
}

async function runRejectSecondSubmitTests(): Promise<void> {
    setupJsdom();
    installAssetStubs();
    const factory = nodeRequire('jiti') as unknown as JitiFactory;
    const innerJiti = factory(path.join(repoRoot, 'index.js'), {
        alias: { '@': repoRoot },
        jsx: true,
    });
    // 中文注释：经 inner-jiti 加载真实 Composer 与真实 chatStore（同一实例，共享 Zustand）。
    const composerMod = innerJiti('./app/(main)/chat/components/Composer/Composer.tsx') as unknown as {
        default: React.ComponentType<ComposerPropsLike>;
    };
    const chatStoreMod = innerJiti('./stores/chatStore.ts') as unknown as { useChatStore: ChatStoreLike };
    const Composer = composerMod.default;
    const useChatStore = chatStoreMod.useChatStore;
    const ReactMod = nodeRequire('react') as typeof React;
    const rtl = nodeRequire('@testing-library/react') as typeof import('@testing-library/react');

    console.log('=== REJECT-01: 同 tick 双提交仅一次 onSubmit（真实 submittingRef 同步锁）===');
    {
        useChatStore.getState().reset();
        let submitCalls = 0;
        let releaseGate: (() => void) | null = null;
        const gate = new Promise<void>((resolve) => {
            releaseGate = resolve;
        });
        const onSubmit = async (content: string): Promise<void> => {
            submitCalls += 1;
            assert.strictEqual(content, '流式中第二次提交探针', '提交内容必须为输入原文');
            // 中文注释：首个提交挂起，模拟流式在途（isLocalSending 置位窗口）。
            await gate;
        };
        const renderResult = rtl.render(
            ReactMod.createElement(Composer, { value: '流式中第二次提交探针', onChange: () => {}, onSubmit }),
        );
        await rtl.act(async () => {
            await new Promise((r) => setTimeout(r, 200));
        });
        const { sendButton } = queryComposerNodes();
        // 中文注释：同 tick 双发（两次 click 间不 await，复刻双 Enter 同帧到达；去自造 gate，直驱真实 handleSubmit）。
        rtl.fireEvent.click(sendButton);
        rtl.fireEvent.click(sendButton);
        await new Promise((r) => setTimeout(r, 300));
        assert.strictEqual(submitCalls, 1, `同 tick 双发必须只提交一次，实际 ${submitCalls} 次`);
        // 中文注释：真实入库断言经 chatStore（提交门仿真改为真实 dispatch 计数，此处以 onSubmit 单次为准）。
        (releaseGate as unknown as () => void)();
        await rtl.act(async () => {
            await new Promise((r) => setTimeout(r, 300));
        });
        assert.strictEqual(submitCalls, 1, '释放后不得补发第二次');
        renderResult.unmount();
        useChatStore.getState().reset();
    }
    console.log('PASS: REJECT-01 真实组件同 tick 单次提交');

    console.log('=== REJECT-02: 流式中（isSending）第二次提交被拒（真实 effectiveDisabled）===');
    {
        useChatStore.getState().reset();
        // 中文注释：制造真实流式在途（store sending），Composer 以 isSending=true 渲染（ChatLayout 同接线）。
        useChatStore.getState().dispatch({ type: 'user.submit', content: '进行中的流式提问' });
        const sending = useChatStore.getState().messages.some((m) => m.status === 'sending');
        assert.strictEqual(sending, true, '前置：store 必须处于流式发送中');
        let submitCalls = 0;
        const renderResult = rtl.render(
            ReactMod.createElement(Composer, {
                value: '流式中第二次输入',
                onChange: () => {},
                onSubmit: async () => {
                    submitCalls += 1;
                },
                isSending: true,
            }),
        );
        await rtl.act(async () => {
            await new Promise((r) => setTimeout(r, 200));
        });
        const { sendButton, textarea } = queryComposerNodes();
        assert.strictEqual(textarea.disabled, true, '流式中输入框必须禁用（effectiveDisabled）');
        rtl.fireEvent.click(sendButton);
        rtl.fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
        await new Promise((r) => setTimeout(r, 300));
        assert.strictEqual(submitCalls, 0, `流式中第二次提交必须被拒，实际提交 ${submitCalls} 次`);
        renderResult.unmount();
        useChatStore.getState().reset();
    }
    console.log('PASS: REJECT-02 流式中提交被拒');

    console.log('=== REJECT-03: 提交失败后锁释放，允许重试（真实 finally）===');
    {
        useChatStore.getState().reset();
        let submitCalls = 0;
        let shouldFail = true;
        const renderResult = rtl.render(
            ReactMod.createElement(Composer, {
                value: '失败重试探针',
                onChange: () => {},
                onSubmit: async () => {
                    submitCalls += 1;
                    if (shouldFail) {
                        throw new Error('发送过于频繁，请稍后再试');
                    }
                },
            }),
        );
        await rtl.act(async () => {
            await new Promise((r) => setTimeout(r, 200));
        });
        const first = queryComposerNodes().sendButton;
        await rtl.act(async () => {
            rtl.fireEvent.click(first);
            await new Promise((r) => setTimeout(r, 400));
        });
        assert.strictEqual(submitCalls, 1, '首次提交必须到达 onSubmit');
        // 中文注释：失败后同步锁必须释放（GlassToast 展示错误但不粘锁），重试可再次提交。
        shouldFail = false;
        const second = queryComposerNodes().sendButton;
        await rtl.act(async () => {
            rtl.fireEvent.click(second);
            await new Promise((r) => setTimeout(r, 400));
        });
        assert.strictEqual(submitCalls, 2, '失败后重试必须允许第二次提交（锁不得粘住）');
        renderResult.unmount();
        useChatStore.getState().reset();
    }
    console.log('PASS: REJECT-03 失败释放锁且可重试');

    console.log('=== REJECT-04: 真实 Composer 同步锁接线锁定（源码补充）===');
    {
        // 中文注释：行为已由 REJECT-01~03 真实渲染覆盖；此处仅锁定关键接线不回归（与旧 H-04-02 同语义）。
        const source = readFileSync(
            path.join(repoRoot, 'app/(main)/chat/components/Composer/Composer.tsx'),
            'utf8',
        );
        assert.ok(/const\s+submittingRef\s*=\s*useRef\s*\(\s*false\s*\)/.test(source), '必须声明 submittingRef 同步锁');
        assert.ok(source.includes('if (submittingRef.current)'), 'handleSubmit 必须先查同步锁');
        assert.ok(source.includes('submittingRef.current = true'), '提交前必须置同步锁');
        assert.ok(source.includes('disabled || isSending || isLocalSending'), 'effectiveDisabled 须保留三源合并');
    }
    console.log('PASS: REJECT-04 同步锁接线锁定');

    console.log('\nALL REJECT SECOND SUBMIT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runRejectSecondSubmitTests()
    .then(() => {
        console.log('ALL REJECT SECOND SUBMIT TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Reject second submit test failed:', error);
        process.exit(1);
    });

export default testPromise;
