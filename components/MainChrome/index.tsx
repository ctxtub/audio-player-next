'use client';

/**
 *  MainChrome（ §15/§16/§30 +  spec §5 Global Layer）。
 *
 * 结构：
 * ```text
 * .app（styles/app.module.scss，含 --bottom-chrome-safe-bottom）
 * ├── main.content（页面 children）
 * ├── BottomChrome
 * │   ├── Mini slot（visible 才挂载 MiniNowPlaying；Expanded open 时 suppress）
 * │   └── MainTabBar
 * └── NowPlayingLayer (Expanded；页面导航不卸载，与 Audio Host 同 Global Layer)
 * ```
 *
 *  owner 说明：AudioControllerHost 不在本组件内挂载，仍由
 * app/(main)/layout.tsx 与 MainChrome 平级挂载为唯一全局 owner，
 * 跨 /chat /library /setting 不重复挂载、不重复 beginSession。
 * 本组件只读 Session 派生显隐/预留 + UI isExpanded suppress Mini，
 * 不 mutation PlaybackSessionStore.sessionId/status/source/continuationMode，
 * 不 clear Session、不 pause、不改 Anchor、不写第二套显隐标记。
 * Expanded open/close 一律不触发 play/pause/new Session（ §9）。
 */

import React, { useEffect, useRef } from 'react';

import appStyles from '@/styles/app.module.scss';

import { NowPlayingLayer } from '@/components/NowPlaying/NowPlayingLayer';
import { BottomChrome } from './BottomChrome';
import { useMainChromeState } from './useMainChromeState';

/** MainChrome props（仅透传页面 children）。 */
export type MainChromeProps = {
    children: React.ReactNode;
};

/**
 * 主应用 Chrome：统一底部预留 + Mini slot + TabBar。
 * hasDockedMini 才给 .app 叠加 appWithDockedNowPlaying
 *（无 session / keyboard 抑制 / floating 时不保留幽灵空间）。
 */
export const MainChrome: React.FC<MainChromeProps> = ({ children }) => {
    const state = useMainChromeState();
    const appRef = useRef<HTMLDivElement | null>(null);

    const appClassName = state.hasDockedMini
        ? `${appStyles.app} ${appStyles.appWithDockedNowPlaying}`
        : appStyles.app;

    /**
     * 安全区真实高度：docked Mini 挂载时用 ResizeObserver 测量其真实高度，
     * 写入 --mini-player-occupied-height（长标题换行撑高时仍足额避让）；
     * 未 docked（无 session/Expanded/keyboard/floating）时清除内联值，
     * 回落样式表 0px，不残留固定空白。SSR 无 ResizeObserver 时静默跳过。
     */
    useEffect(() => {
        const appEl = appRef.current;
        if (!appEl || !state.hasDockedMini) {
            appEl?.style.removeProperty('--mini-player-occupied-height');
            return undefined;
        }
        if (typeof window === 'undefined' || typeof ResizeObserver === 'undefined') {
            return undefined;
        }
        const applyHeight = (height: number): void => {
            if (Number.isFinite(height) && height > 0) {
                appEl.style.setProperty('--mini-player-occupied-height', `${Math.ceil(height)}px`);
            }
        };
        const miniEl = appEl.querySelector('[data-testid="mini-now-playing"]');
        if (miniEl) {
            applyHeight(miniEl.getBoundingClientRect().height);
        }
        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (entry) {
                applyHeight(entry.contentRect.height);
            }
        });
        if (miniEl) {
            observer.observe(miniEl);
        }
        return () => {
            observer.disconnect();
            appEl.style.removeProperty('--mini-player-occupied-height');
        };
    }, [state.hasDockedMini]);

    return (
        <div
            ref={appRef}
            className={appClassName}
            data-testid="main-chrome"
            data-has-docked-mini={state.hasDockedMini ? 'true' : 'false'}
            data-mini-visible={state.visible ? 'true' : 'false'}
            data-layoutmode={state.layoutMode}
            data-expanded={state.isExpanded ? 'true' : 'false'}
        >
            <main className={appStyles.content} data-testid="main-chrome-content">
                {children}
            </main>
            <BottomChrome
                visible={state.visible}
                hasDockedMini={state.hasDockedMini}
                layoutMode={state.layoutMode}
            />
            <NowPlayingLayer />
        </div>
    );
};

export default MainChrome;
