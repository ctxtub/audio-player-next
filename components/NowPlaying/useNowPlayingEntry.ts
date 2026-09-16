'use client';

/**
 *  NowPlaying Entry Facade（ spec §6 / §6.1， closure 现状）。
 *
 * Mini 只调用 openDetails()/openExpanded()，不直接感知路由/Expanded 形态。
 *  正式语义：openDetails/openExpanded → nowPlayingUiStore.openExpanded()
 *（Expanded 不属于 route，URL 不变；Mini Component 零改动，spec §6）。
 *
 *  legacy 兼容符号已随旧播放器产品入口退役删除；本文件仅保留
 *  正式入口（useNowPlayingEntry / createExpandedNowPlayingEntryController /
 * NowPlayingEntryController 类型，Mini 消费）。
 */

import { useCallback, useMemo } from 'react';

import { useNowPlayingUiStore } from '@/stores/nowPlayingUiStore';

/** NowPlaying 入口控制器（Expanded UI）。 */
export type NowPlayingEntryController = {
    /** 打开详情（ → Expanded UI open，URL 不变；透传触发元素供焦点返回）。 */
    openDetails: (target?: HTMLElement | null) => void;
    /** 打开 Expanded（与 openDetails 同义，满足命名迁移契约）。 */
    openExpanded: (target?: HTMLElement | null) => void;
};

/**
 * 纯工厂（，可独立测试）：给定 UI open 构造控制器。
 * openDetails/openExpanded 均委托同一 UI open，不触路由/播放。
 */
export const createExpandedNowPlayingEntryController = (
    openUi: (target?: HTMLElement | null) => void
): NowPlayingEntryController => ({
    openDetails: (target?: HTMLElement | null) => openUi(target),
    openExpanded: (target?: HTMLElement | null) => openUi(target),
});

/**
 * Entry hook：绑定 NowPlaying UI Store（不再绑定 Next Router）。
 * Mini Metadata onClick 只调 openDetails()/openExpanded()，URL 不变（验收 1）。
 */
export const useNowPlayingEntry = (): NowPlayingEntryController => {
    const openExpandedStore = useNowPlayingUiStore((state) => state.openExpanded);

    const open = useCallback(
        (target?: HTMLElement | null) => {
            openExpandedStore(target);
        },
        [openExpandedStore]
    );

    return useMemo(() => createExpandedNowPlayingEntryController(open), [open]);
};
