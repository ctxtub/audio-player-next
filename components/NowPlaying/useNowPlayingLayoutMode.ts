'use client';

/**
 *  Mini Now Playing — Responsive Hook（ foundation）。
 *
 * 冻结契约：mobile/docked <768px；desktop >=768px。
 * 同一契约来源：SCSS styles/tokens/_breakpoints.scss 的 $breakpoint-lg
 * 与此文件的 NOW_PLAYING_BREAKPOINT_PX 必须同为 768（单测锁定，禁止 1024 第二边界）。
 *
 * 本项不负责 Mini 显隐，只提供 viewport → layoutMode 派生。
 */

import { useEffect, useState } from 'react';

import {
    NOW_PLAYING_BREAKPOINT_PX,
    type MiniNowPlayingLayoutMode,
    type NowPlayingViewportMode,
} from './types';

export { NOW_PLAYING_BREAKPOINT_PX };
export type { MiniNowPlayingLayoutMode, NowPlayingViewportMode };

/**
 * 纯函数：viewport 宽度 → compact/wide。
 * 边界：767→compact；768→wide（含 768）。
 */
export const resolveViewportMode = (width: number): NowPlayingViewportMode =>
    width < NOW_PLAYING_BREAKPOINT_PX ? 'compact' : 'wide';

/**
 * 纯函数：viewport 宽度 + 桌面偏好 → 三态 layoutMode。
 * - compact → compact-docked（偏好不影响移动端）；
 * - wide + pref true → wide-floating；
 * - wide + pref false → wide-docked。
 */
export const resolveNowPlayingLayoutMode = (
    width: number,
    desktopFloatingPlayerEnabled: boolean
): MiniNowPlayingLayoutMode => {
    const mode = resolveViewportMode(width);
    if (mode === 'compact') {
        return 'compact-docked';
    }
    return desktopFloatingPlayerEnabled ? 'wide-floating' : 'wide-docked';
};

/**
 * 读取当前 viewport 宽度（SSR 下为 null）。
 */
const readViewportWidth = (): number | null => {
    if (typeof window === 'undefined') {
        return null;
    }
    return window.innerWidth;
};

/**
 * 响应式 viewport 粗模式（compact/wide），监听 resize/visualViewport 变化。
 * SSR 首帧返回 compact（mobile-first），hydration 后以真实宽度为准。
 */
export const useViewportMode = (): NowPlayingViewportMode => {
    const [width, setWidth] = useState<number | null>(() => readViewportWidth());

    useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }
        const onResize = () => {
            setWidth(window.innerWidth);
        };
        window.addEventListener('resize', onResize);
        const vv = window.visualViewport;
        vv?.addEventListener('resize', onResize);
        // 首挂载同步一次（覆盖横竖屏/桌面缩放后的初始值漂移）。
        onResize();
        return () => {
            window.removeEventListener('resize', onResize);
            vv?.removeEventListener('resize', onResize);
        };
    }, []);

    if (width === null) {
        return 'compact';
    }
    return resolveViewportMode(width);
};

/**
 * 响应式 Mini 布局模式：viewport + 桌面偏好派生。
 * desktopFloatingPlayerEnabled 只决定 wide 下 floating/docked，不影响 compact。
 *
 * @param desktopFloatingPlayerEnabled 宽屏是否悬浮（来自 configStore 新语义字段）
 */
export const useNowPlayingLayoutMode = (
    desktopFloatingPlayerEnabled: boolean
): MiniNowPlayingLayoutMode => {
    const viewportMode = useViewportMode();
    if (viewportMode === 'compact') {
        return 'compact-docked';
    }
    return desktopFloatingPlayerEnabled ? 'wide-floating' : 'wide-docked';
};
