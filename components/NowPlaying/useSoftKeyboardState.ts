'use client';

/**
 * M6 Mini Now Playing — 软键盘 detector（M6-01 foundation）。
 *
 * 只验证 detector 能力（open/closed 可独立测试），本项不负责 Mini 显隐。
 * 后续 Slice 的 Mini 可见性公式（compact + keyboard open → suppressed）消费此 hook，
 * 但本文件不引入 Session/visible 逻辑。
 *
 * 检测策略（与 spec §17.2 对齐）：
 * - 优先：visualViewport 高度明显小于 layout 高度 + 可编辑元素聚焦；
 * - 退化：不支持 visualViewport 的浏览器，compact 下可编辑聚焦即视为 open
 *  （宁可短暂隐藏 Mini，也不要遮挡输入）。
 */

import { useEffect, useState } from 'react';

import type { SoftKeyboardSignal, SoftKeyboardState } from './types';

export type { SoftKeyboardSignal, SoftKeyboardState };

/** visualViewport 高度收缩阈值（px）：超过即判定键盘展开。 */
export const SOFT_KEYBOARD_SHRINK_THRESHOLD_PX = 150;

/** 可编辑元素标签名（大小写不敏感）。 */
const EDITABLE_TAG_NAMES = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** 不触发键盘的 input 类型（checkbox/radio 等不弹软键盘）。 */
const NON_KEYBOARD_INPUT_TYPES = new Set([
    'checkbox',
    'radio',
    'button',
    'submit',
    'reset',
    'range',
    'color',
    'file',
    'image',
    'hidden',
]);

/**
 * 纯函数：给定元素是否为可编辑元素（input/textarea/select/contenteditable）。
 * 供单测独立验证，不依赖真实 focus。
 */
export const isEditableElement = (el: Element | null | undefined): boolean => {
    if (!el || typeof (el as HTMLElement).tagName !== 'string') {
        return false;
    }
    const tag = (el as HTMLElement).tagName.toUpperCase();
    if (tag === 'TEXTAREA') {
        return true;
    }
    if (tag === 'SELECT') {
        return true;
    }
    if (tag === 'INPUT') {
        const type = String((el as HTMLInputElement).type ?? 'text').toLowerCase();
        return !NON_KEYBOARD_INPUT_TYPES.has(type);
    }
    const htmlEl = el as HTMLElement;
    if (typeof htmlEl.isContentEditable === 'boolean' && htmlEl.isContentEditable) {
        return true;
    }
    if (typeof htmlEl.getAttribute === 'function') {
        const ce = htmlEl.getAttribute('contenteditable');
        if (ce !== null && ce !== 'false') {
            return true;
        }
    }
    return EDITABLE_TAG_NAMES.has(tag);
};

/**
 * 纯函数：综合信号判定软键盘 open/closed（可独立测试）。
 * - 有 visualViewport：editableFocused && (layoutHeight - vvHeight > 阈值) → open；
 * - 无 visualViewport（fallback）：editableFocused → open。
 */
export const shouldTreatAsKeyboardOpen = (signal: SoftKeyboardSignal): boolean => {
    if (!signal.isEditableFocused) {
        return false;
    }
    if (!signal.hasVisualViewport || signal.visualViewportHeight === null) {
        return true;
    }
    const shrink = signal.layoutHeight - signal.visualViewportHeight;
    return shrink > SOFT_KEYBOARD_SHRINK_THRESHOLD_PX;
};

/**
 * 读取当前 document.activeElement 是否为可编辑元素（SSR 安全）。
 */
const readEditableFocused = (): boolean => {
    if (typeof document === 'undefined') {
        return false;
    }
    try {
        return isEditableElement(document.activeElement as Element | null);
    } catch {
        return false;
    }
};

/**
 * 读取当前 visualViewport 高度（不支持时为 null）。
 */
const readVisualViewportHeight = (): number | null => {
    if (typeof window === 'undefined') {
        return null;
    }
    const vv = window.visualViewport;
    if (!vv || typeof vv.height !== 'number') {
        return null;
    }
    return vv.height;
};

/**
 * 软键盘 detector hook：返回 { isOpen }。
 * 监听 visualViewport.resize/scroll + focusin/focusout，综合判定 open/closed。
 */
export const useSoftKeyboardState = (): SoftKeyboardState => {
    const [isOpen, setIsOpen] = useState<boolean>(false);

    useEffect(() => {
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return;
        }

        const recompute = () => {
            const vvHeight = readVisualViewportHeight();
            setIsOpen(
                shouldTreatAsKeyboardOpen({
                    isEditableFocused: readEditableFocused(),
                    visualViewportHeight: vvHeight,
                    layoutHeight: window.innerHeight,
                    hasVisualViewport: vvHeight !== null,
                })
            );
        };

        recompute();

        const vv = window.visualViewport;
        vv?.addEventListener('resize', recompute);
        vv?.addEventListener('scroll', recompute);
        document.addEventListener('focusin', recompute);
        document.addEventListener('focusout', recompute);
        window.addEventListener('resize', recompute);

        return () => {
            vv?.removeEventListener('resize', recompute);
            vv?.removeEventListener('scroll', recompute);
            document.removeEventListener('focusin', recompute);
            document.removeEventListener('focusout', recompute);
            window.removeEventListener('resize', recompute);
        };
    }, []);

    return { isOpen };
};
