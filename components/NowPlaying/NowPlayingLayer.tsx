'use client';

/**
 * M7-01 NowPlayingLayer（spec §5 Global Layer + §8 自动关闭 + §42 Focus Return）。
 *
 * 结构（M7）：
 * ```text
 * MainChrome
 * ├── Page
 * ├── BottomChrome (Mini + TabBar)
 * └── NowPlayingLayer (Expanded)
 * ```
 *
 * 职责：
 * - 订阅 isExpanded（UI）+ source/status（M5 Session），唯一自动关闭条件：
 *   source == null 或 status == idle（spec §8；logout/切账号/删 Work/clear 覆盖）；
 *   pause / ended / error / synthesizing / 普通 route change 均不自动关闭
 *   （spec §44：Expanded 不属于 route，导航后保持 open）。
 * - 关闭后焦点返回：优先 returnFocusTarget（实际 trigger），若已 detached
 *   回退 Mini Metadata trigger（spec §42）；打开时焦点由 Dialog/关闭按钮承接。
 * - 本层不改变 Session/Transport（不 play/pause/new Session，不 clear）。
 */

import React, { useEffect, useRef } from 'react';

import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import { useNowPlayingUiStore } from '@/stores/nowPlayingUiStore';

import { ExpandedNowPlaying } from './ExpandedNowPlaying';

/** Mini Metadata 触发器选择器（focus return fallback，spec §42）。 */
export const MINI_METADATA_TRIGGER_SELECTOR = '[data-testid="mini-metadata-button"]';

/**
 * 纯判定：给定 Session 是否应自动关闭 Expanded（spec §8）。
 * 仅 source == null 或 status == idle 返回 true；其余（含 ended/error/
 * synthesizing/paused/playing/ready/hydrating）一律 false。
 */
export const shouldAutoCloseExpanded = (input: {
    source: unknown;
    status: string;
}): boolean => {
    if (input.source === null || input.source === undefined) {
        return true;
    }
    return input.status === 'idle';
};

/** 焦点返回：优先已捕获 trigger，detached/聚焦失败时回退 Mini trigger。 */
const returnFocusToTrigger = (captured: HTMLElement | null): void => {
    try {
        if (captured && typeof captured.isConnected === 'boolean') {
            // body/documentElement 不是有效 trigger（WebKit 未聚焦时的误捕获），直接走 fallback。
            try {
                if (
                    typeof document !== 'undefined' &&
                    (captured === document.body || captured === document.documentElement)
                ) {
                    throw new Error('captured-is-root');
                }
                const tag = typeof captured.tagName === 'string' ? captured.tagName.toUpperCase() : '';
                if (tag === 'BODY' || tag === 'HTML') {
                    throw new Error('captured-is-root');
                }
            } catch (rootErr) {
                if (rootErr instanceof Error && rootErr.message === 'captured-is-root') {
                    throw rootErr;
                }
                // tagName 读取异常不阻断聚焦尝试。
            }
            if (captured.isConnected && typeof captured.focus === 'function') {
                captured.focus({ preventScroll: true } as FocusOptions);
                // 聚焦后校验：WebKit 下 body.focus() 不抛错但 activeElement 不变，
                // 必须校验命中才算成功，否则继续走 MINI trigger fallback。
                try {
                    if (typeof document !== 'undefined' && document.activeElement === captured) {
                        return;
                    }
                } catch {
                    // activeElement 读取异常视为未命中，走 fallback。
                }
                throw new Error('focus-not-applied');
            }
        } else if (captured && typeof captured.focus === 'function') {
            // jsdom 无 isConnected：直接尝试聚焦（失败则走 fallback）。
            try {
                captured.focus();
                if (typeof document !== 'undefined' && document.activeElement === captured) {
                    return;
                }
            } catch {
                // 继续 fallback。
            }
        }
    } catch {
        // 忽略聚焦异常，走 fallback。
    }
    try {
        if (typeof document !== 'undefined') {
            const fallback = document.querySelector(
                MINI_METADATA_TRIGGER_SELECTOR
            ) as unknown as { focus?: () => void } | null;
            fallback?.focus?.();
        }
    } catch {
        // fallback 聚焦失败不抛错（无障碍尽力而为）。
    }
};

/**
 * Global Layer：挂载 Expanded，监听自动关闭与焦点返回。
 * 页面导航不会卸载本层（属于 (main) Global Layer，与 Audio Host 同级语义）。
 */
export const NowPlayingLayer: React.FC = () => {
    const isExpanded = useNowPlayingUiStore((state) => state.isExpanded);
    const returnFocusTarget = useNowPlayingUiStore((state) => state.returnFocusTarget);
    const closeExpanded = useNowPlayingUiStore((state) => state.closeExpanded);
    const source = usePlaybackSessionStore((state) => state.source);
    const status = usePlaybackSessionStore((state) => state.status);

    const wasExpandedRef = useRef(false);
    const targetRef = useRef<HTMLElement | null>(null);
    if (isExpanded) {
        targetRef.current = returnFocusTarget;
    }

    // 自动关闭唯一条件（spec §8）：source 空或 idle；其它状态保持 open。
    useEffect(() => {
        if (!isExpanded) {
            return;
        }
        if (shouldAutoCloseExpanded({ source, status })) {
            closeExpanded();
        }
    }, [isExpanded, source, status, closeExpanded]);

    // 焦点返回：expanded true→false 跳变后恢复（spec §42）。
    useEffect(() => {
        const wasExpanded = wasExpandedRef.current;
        if (wasExpanded && !isExpanded) {
            const captured = targetRef.current;
            // 下一帧执行，保证 Mini 已重新挂载（suppressed 解除）后再聚焦。
            const raf =
                typeof requestAnimationFrame !== 'undefined'
                    ? requestAnimationFrame(() => returnFocusToTrigger(captured))
                    : (setTimeout(() => returnFocusToTrigger(captured), 0) as unknown as number);
            targetRef.current = null;
            wasExpandedRef.current = false;
            return () => {
                try {
                    if (typeof cancelAnimationFrame !== 'undefined' && typeof raf === 'number') {
                        cancelAnimationFrame(raf);
                    } else {
                        clearTimeout(raf as unknown as ReturnType<typeof setTimeout>);
                    }
                } catch {
                    // 忽略清理异常。
                }
            };
        }
        wasExpandedRef.current = isExpanded;
        return undefined;
    }, [isExpanded]);

    return (
        <div data-testid="now-playing-layer" data-expanded={isExpanded ? 'true' : 'false'}>
            <ExpandedNowPlaying />
        </div>
    );
};

export default NowPlayingLayer;
