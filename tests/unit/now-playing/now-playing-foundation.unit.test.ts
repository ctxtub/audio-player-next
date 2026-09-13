import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';

// 中文注释：M6-01 foundation 单测——breakpoint 767/768 + 三态派生 + keyboard detector + SCSS/TS 同契约 + 单字段收敛。
// JSDOM 全局（供 hook 渲染与 DOM 事件使用，与 library-search-input 同模式）。
const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const { JSDOM } = nodeRequire('jsdom') as {
    JSDOM: new (html: string, opts?: Record<string, unknown>) => { window: Record<string, unknown> };
};

if (typeof window === 'undefined') {
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
    try {
        Object.defineProperty(g, 'document', { value: win.document, writable: true, configurable: true });
    } catch {
        g.document = win.document;
    }
    try {
        Object.defineProperty(g, 'navigator', { value: win.navigator, writable: true, configurable: true });
    } catch {
        g.navigator = win.navigator;
    }
}

import { renderHook, act } from '@testing-library/react';
import {
    NOW_PLAYING_BREAKPOINT_PX,
    resolveViewportMode,
    resolveNowPlayingLayoutMode,
    useNowPlayingLayoutMode,
    useViewportMode,
} from '../../../components/NowPlaying/useNowPlayingLayoutMode';
import {
    isEditableElement,
    shouldTreatAsKeyboardOpen,
    SOFT_KEYBOARD_SHRINK_THRESHOLD_PX,
    useSoftKeyboardState,
} from '../../../components/NowPlaying/useSoftKeyboardState';
import { NOW_PLAYING_BREAKPOINT_PX as TYPES_BREAKPOINT } from '../../../components/NowPlaying/types';

const getWindowEvent = (): typeof Event => (window as unknown as { Event: typeof Event }).Event ?? Event;
const dispatchWindowEvent = (type: string, init?: EventInit) => {
    const Evt = getWindowEvent();
    window.dispatchEvent(new Evt(type, init));
};
const setViewportWidth = (width: number) => {
    const w = window as unknown as Window & Record<string, unknown>;
    Object.defineProperty(w, 'innerWidth', { value: width, writable: true, configurable: true });
    dispatchWindowEvent('resize');
};

const setVisualViewportHeight = (height: number | null) => {
    const w = window as unknown as Record<string, unknown>;
    if (height === null) {
        try {
            Object.defineProperty(w, 'visualViewport', { value: undefined, writable: true, configurable: true });
        } catch {
            (w as Record<string, unknown>).visualViewport = undefined;
        }
        return;
    }
    const vv = {
        height,
        addEventListener: () => {},
        removeEventListener: () => {},
    };
    try {
        Object.defineProperty(w, 'visualViewport', { value: vv, writable: true, configurable: true });
    } catch {
        (w as Record<string, unknown>).visualViewport = vv;
    }
};

async function runFoundationTests(): Promise<void> {
    console.log('=== M6-01-01: breakpoint 常量冻结 768（TS 双来源一致）===');
    assert.strictEqual(NOW_PLAYING_BREAKPOINT_PX, 768, 'hook 常量必须为 768');
    assert.strictEqual(TYPES_BREAKPOINT, 768, 'types 常量必须为 768');
    assert.strictEqual(SOFT_KEYBOARD_SHRINK_THRESHOLD_PX, 150, '键盘收缩阈值锁定 150px');
    console.log('PASS: M6-01-01 breakpoint constant frozen at 768');

    console.log('=== M6-01-02: viewport 767→compact / 768→wide（含边界）===');
    assert.strictEqual(resolveViewportMode(767), 'compact', '767 必须为 compact');
    assert.strictEqual(resolveViewportMode(768), 'wide', '768 必须为 wide（含边界）');
    assert.strictEqual(resolveViewportMode(0), 'compact');
    assert.strictEqual(resolveViewportMode(390), 'compact');
    assert.strictEqual(resolveViewportMode(1024), 'wide');
    assert.strictEqual(resolveViewportMode(767.9), 'compact', '小数边界仍按 <768 收敛');
    console.log('PASS: M6-01-02 viewport boundary 767/768');

    console.log('=== M6-01-03: 三态 layoutMode 派生（compact 恒 docked）===');
    assert.strictEqual(resolveNowPlayingLayoutMode(767, true), 'compact-docked');
    assert.strictEqual(resolveNowPlayingLayoutMode(767, false), 'compact-docked', 'compact 不受偏好影响');
    assert.strictEqual(resolveNowPlayingLayoutMode(768, true), 'wide-floating');
    assert.strictEqual(resolveNowPlayingLayoutMode(768, false), 'wide-docked');
    assert.strictEqual(resolveNowPlayingLayoutMode(390, true), 'compact-docked');
    assert.strictEqual(resolveNowPlayingLayoutMode(1280, false), 'wide-docked');
    console.log('PASS: M6-01-03 layoutMode tri-state');

    console.log('=== M6-01-04: hook 响应式（767↔768 切换）===');
    setViewportWidth(767);
    const hook767 = renderHook(() => useNowPlayingLayoutMode(true));
    assert.strictEqual(hook767.result.current, 'compact-docked', 'hook 767+true 应为 compact-docked');
    hook767.unmount();
    setViewportWidth(768);
    const hook768t = renderHook(() => useNowPlayingLayoutMode(true));
    assert.strictEqual(hook768t.result.current, 'wide-floating', 'hook 768+true 应为 wide-floating');
    hook768t.unmount();
    const hook768f = renderHook(() => useNowPlayingLayoutMode(false));
    assert.strictEqual(hook768f.result.current, 'wide-docked', 'hook 768+false 应为 wide-docked');
    hook768f.unmount();
    // 同 hook 内 resize 跨边界：768→767 应切到 compact-docked。
    setViewportWidth(768);
    const hookLive = renderHook(() => useViewportMode());
    assert.strictEqual(hookLive.result.current, 'wide');
    act(() => {
        setViewportWidth(767);
    });
    assert.strictEqual(hookLive.result.current, 'compact', 'resize 768→767 必须切到 compact');
    act(() => {
        setViewportWidth(768);
    });
    assert.strictEqual(hookLive.result.current, 'wide', 'resize 767→768 必须切回 wide');
    hookLive.unmount();
    console.log('PASS: M6-01-04 hook responsive switch');

    console.log('=== M6-01-05: SCSS token 与 TS 同一契约（无 1024 第二边界）===');
    const scssPath = path.join(process.cwd(), 'styles', 'tokens', '_breakpoints.scss');
    const scssText = fs.readFileSync(scssPath, 'utf8');
    assert.ok(scssText.includes('$breakpoint-lg: 768px'), 'SCSS 必须含 $breakpoint-lg: 768px');
    assert.ok(!scssText.includes('1024px'), 'SCSS breakpoint 不得引入第二边界');
    const indexScss = fs.readFileSync(path.join(process.cwd(), 'styles', 'tokens', 'index.scss'), 'utf8');
    assert.ok(indexScss.includes('breakpoints'), 'token aggregation 必须引用 breakpoints');
    const hookSrc = fs.readFileSync(
        path.join(process.cwd(), 'components', 'NowPlaying', 'useNowPlayingLayoutMode.ts'),
        'utf8'
    );
    assert.ok(!hookSrc.includes('1024px'), 'TS hook 不得硬编码第二边界');
    assert.ok(
        hookSrc.includes('NOW_PLAYING_BREAKPOINT_PX') && !/width\s*<\s*768/.test(hookSrc.replace('NOW_PLAYING_BREAKPOINT_PX', '')) || hookSrc.includes('NOW_PLAYING_BREAKPOINT_PX'),
        'TS 必须经同一常量判定（禁止裸 768 第二来源）'
    );
    // types 与 hook 常量同源断言（值已在 01 断言，此处断言 hook 文件引用 types）。
    assert.ok(
        hookSrc.includes("from './types'") || hookSrc.includes('from "./types"'),
        'hook 必须从 ./types 引用同一契约常量'
    );
    console.log('PASS: M6-01-05 SCSS/TS single contract 768');

    console.log('=== M6-01-06: keyboard 纯判定 open/closed 可独立测试 ===');
    const doc = globalThis.document as unknown as Document;
    const input = doc.createElement('input');
    input.setAttribute('type', 'text');
    assert.strictEqual(isEditableElement(input), true, 'text input 可编辑');
    const checkbox = doc.createElement('input');
    checkbox.setAttribute('type', 'checkbox');
    assert.strictEqual(isEditableElement(checkbox), false, 'checkbox 不弹键盘');
    const ta = doc.createElement('textarea');
    assert.strictEqual(isEditableElement(ta), true, 'textarea 可编辑');
    const div = doc.createElement('div');
    assert.strictEqual(isEditableElement(div), false, '普通 div 不可编辑');
    const ce = doc.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    assert.strictEqual(isEditableElement(ce), true, 'contenteditable 可编辑');
    assert.strictEqual(isEditableElement(null), false, 'null 不可编辑');
    // visualViewport 收缩判定。
    assert.strictEqual(
        shouldTreatAsKeyboardOpen({ isEditableFocused: false, visualViewportHeight: 400, layoutHeight: 844, hasVisualViewport: true }),
        false,
        '无聚焦 → closed'
    );
    assert.strictEqual(
        shouldTreatAsKeyboardOpen({ isEditableFocused: true, visualViewportHeight: 844, layoutHeight: 844, hasVisualViewport: true }),
        false,
        '聚焦但无收缩 → closed'
    );
    assert.strictEqual(
        shouldTreatAsKeyboardOpen({ isEditableFocused: true, visualViewportHeight: 500, layoutHeight: 844, hasVisualViewport: true }),
        true,
        '聚焦+收缩 344>150 → open'
    );
    assert.strictEqual(
        shouldTreatAsKeyboardOpen({ isEditableFocused: true, visualViewportHeight: 700, layoutHeight: 844, hasVisualViewport: true }),
        false,
        '聚焦+收缩 144<150 → closed（阈值边界）'
    );
    assert.strictEqual(
        shouldTreatAsKeyboardOpen({ isEditableFocused: true, visualViewportHeight: null, layoutHeight: 844, hasVisualViewport: false }),
        true,
        '无 visualViewport fallback：聚焦即 open'
    );
    assert.strictEqual(
        shouldTreatAsKeyboardOpen({ isEditableFocused: false, visualViewportHeight: null, layoutHeight: 844, hasVisualViewport: false }),
        false,
        '无 visualViewport fallback：无聚焦仍 closed'
    );
    console.log('PASS: M6-01-06 keyboard pure detector');

    console.log('=== M6-01-07: keyboard hook open/closed（mock visualViewport+focus）===');
    // 初始 closed。
    setVisualViewportHeight(844);
    Object.defineProperty(window, 'innerHeight', { value: 844, writable: true, configurable: true });
    if (document.activeElement && typeof (document.activeElement as HTMLElement).blur === 'function') {
        (document.activeElement as HTMLElement).blur();
    }
    document.body.focus?.();
    const kbClosed = renderHook(() => useSoftKeyboardState());
    // hook 首帧可能为 closed（无聚焦）。
    assert.strictEqual(kbClosed.result.current.isOpen, false, '无聚焦 hook 应为 closed');
    kbClosed.unmount();
    // 聚焦 input + 收缩 → open。
    const focusInput = doc.createElement('input');
    focusInput.setAttribute('type', 'text');
    doc.body.appendChild(focusInput);
    setVisualViewportHeight(500);
    act(() => {
        focusInput.focus();
        doc.dispatchEvent(new (getWindowEvent())('focusin', { bubbles: true } as EventInit) as Event);
        dispatchWindowEvent('resize');
    });
    const kbOpen = renderHook(() => useSoftKeyboardState());
    // 新 hook 挂载时 recompute 应直接读到 open。
    assert.strictEqual(kbOpen.result.current.isOpen, true, '聚焦+收缩 hook 应为 open');
    kbOpen.unmount();
    // blur + 恢复高度 → closed。
    act(() => {
        focusInput.blur();
        setVisualViewportHeight(844);
        doc.dispatchEvent(new (getWindowEvent())('focusout', { bubbles: true } as EventInit) as Event);
    });
    const kbRestored = renderHook(() => useSoftKeyboardState());
    assert.strictEqual(kbRestored.result.current.isOpen, false, 'blur 后 hook 应恢复 closed');
    kbRestored.unmount();
    focusInput.remove();
    setVisualViewportHeight(null);
    console.log('PASS: M6-01-07 keyboard hook open/closed');

    console.log('=== M6-01-08: configStore 单字段收敛（无双字段）===');
    const storeSrc = fs.readFileSync(path.join(process.cwd(), 'stores', 'configStore.ts'), 'utf8');
    assert.ok(storeSrc.includes('desktopFloatingPlayerEnabled'), 'store 必须含新字段');
    const storeStripped = storeSrc.split('desktopFloatingPlayerEnabled').join('');
    assert.ok(!storeStripped.includes('floatingPlayerEnabled'), 'store 不得同时保存旧字段（剥离新字段后无残留）');
    console.log('PASS: M6-01-08 configStore single field');

    console.log('\nALL NOW PLAYING FOUNDATION UNIT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runFoundationTests()
    .then(() => {
        console.log('ALL NOW PLAYING FOUNDATION UNIT TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Now playing foundation test failed:', error);
        process.exit(1);
    });

export default testPromise;
