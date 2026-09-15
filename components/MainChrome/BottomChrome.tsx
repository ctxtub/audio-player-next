'use client';

/**
 * M7-01 BottomChrome（M6 §15/§16 + M7 spec §5/§7）。
 *
 * 职责：
 * - Mini render slot + TabBar 的统一底部容器；
 * - Mini 渲染只由 MainChrome 传入的 visible 决定（与 reservation 同源，原子一致；
 *   visible 已含 M7 Expanded suppress：Expanded open 时 Mini presentation 隐藏）；
 * - 本组件自身不读 Session/Keyboard/viewport/UI Expanded，不 mutation 任何 store，
 *   不 clear Session、不 pause、不改 Anchor（M5 owner 边界）；
 * - Mini 点击语义为 M7 useNowPlayingEntry → nowPlayingUiStore.openExpanded()
 *   （URL 不变；/player 物理保留至 M9，本层不包路由、不改 entry 契约）；
 * - 移动端 docked Mini 不可拖：本层与 Mini 均不绑定任何 drag 手势
 *   （桌面 drag 归 M6-04，Expanded Sheet drag 归 NowPlayingLayer/Handle）。
 */

import React from 'react';

import MainTabBar from '@/components/MainTabBar';
import { MiniNowPlaying } from '@/components/NowPlaying/MiniNowPlaying';
import type { MiniNowPlayingLayoutMode } from '@/components/NowPlaying/types';

import styles from './index.module.scss';

/** BottomChrome props（全部由 MainChrome 单源传入，不各自派生）。 */
export type BottomChromeProps = {
    /** 是否渲染 Mini（MainChrome.visible，与 reservation 同源）。 */
    visible: boolean;
    /** 是否为 docked 预留（MainChrome.hasDockedMini，供打点）。 */
    hasDockedMini: boolean;
    /** 三态 layoutMode（透传，供 off-by-one 断言）。 */
    layoutMode: MiniNowPlayingLayoutMode;
};

/**
 * 底部 Chrome：Mini slot + TabBar。
 * display: contents（见样式）：不引入额外布局盒，Mini 仍为 viewport fixed，
 * TabBar 仍为原 fixed 胶囊；reservation 唯一由 .app 的
 * --bottom-chrome-safe-bottom 承担。
 */
export const BottomChrome: React.FC<BottomChromeProps> = ({
    visible,
    hasDockedMini,
    layoutMode,
}) => {
    return (
        <div
            className={styles.bottomChrome}
            data-testid="bottom-chrome"
            data-has-docked-mini={hasDockedMini ? 'true' : 'false'}
            data-layoutmode={layoutMode}
        >
            <div
                data-testid="mini-slot"
                data-visible={visible ? 'true' : 'false'}
                data-layoutmode={layoutMode}
                className={styles.miniSlot}
            >
                {visible ? <MiniNowPlaying /> : null}
            </div>
            <MainTabBar />
        </div>
    );
};

export default BottomChrome;
