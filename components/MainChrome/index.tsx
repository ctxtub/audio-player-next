'use client';

/**
 * M7-01 MainChrome（M6 §15/§16/§30 + M7 spec §5 Global Layer）。
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
 * M5 owner 说明：AudioControllerHost 不在本组件内挂载，仍由
 * app/(main)/layout.tsx 与 MainChrome 平级挂载为唯一全局 owner，
 * 跨 /chat /library /setting 不重复挂载、不重复 beginSession。
 * 本组件只读 Session 派生显隐/预留 + UI isExpanded suppress Mini，
 * 不 mutation PlaybackSessionStore.sessionId/status/source/continuationMode，
 * 不 clear Session、不 pause、不改 Anchor、不写第二套显隐标记。
 * Expanded open/close 一律不触发 play/pause/new Session（M7 §9）。
 */

import React from 'react';

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
 * （无 session / keyboard 抑制 / floating 时不保留幽灵空间）。
 */
export const MainChrome: React.FC<MainChromeProps> = ({ children }) => {
    const state = useMainChromeState();

    const appClassName = state.hasDockedMini
        ? `${appStyles.app} ${appStyles.appWithDockedNowPlaying}`
        : appStyles.app;

    return (
        <div
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
