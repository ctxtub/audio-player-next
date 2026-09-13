'use client';

/**
 * M7-01 NowPlaying Entry Facade（M7 spec §6 / §6.1）。
 *
 * Mini 只调用 openDetails()/openExpanded()，不直接感知路由/Expanded 形态。
 * M6 临时实现：openDetails/openExpanded → router.push('/player')（M1 兼容例外）；
 * M7 正式替换为：openDetails/openExpanded → nowPlayingUiStore.openExpanded()
 * （Expanded 不属于 route，URL 不变；Mini Component 零改动，spec §6）。
 *
 * /player 物理保留至 M9（M7 正常产品入口不再 push 它，spec §6.1/§50）；
 * 遗留纯函数（NOW_PLAYING_COMPAT_ROUTE / shouldSuppress / legacy 工厂）保留为
 * deprecated 兼容（M6 单测锁定 + M9 前路由存在性），新产品路径不再经由它们。
 */

import { useCallback, useMemo } from 'react';

import { useNowPlayingUiStore } from '@/stores/nowPlayingUiStore';

/** NowPlaying 入口控制器（M7：Expanded UI）。 */
export type NowPlayingEntryController = {
    /** 打开详情（M7 → Expanded UI open，URL 不变；透传触发元素供焦点返回）。 */
    openDetails: (target?: HTMLElement | null) => void;
    /** 打开 Expanded（与 openDetails 同义，满足命名迁移契约）。 */
    openExpanded: (target?: HTMLElement | null) => void;
};

/**
 * @deprecated M6 路由兼容常量（M9 删除 /player 时一并移除）。
 * M7 正常产品入口不再 push 它（spec §6.1）；仅供遗留单测与兼容断言。
 */
export const NOW_PLAYING_COMPAT_ROUTE = '/player';

/**
 * @deprecated M6 路由抑制判定（spec §24.1）。
 * Expanded 不属于 route 后 pathname 不再决定开关；保留供 M6 单测兼容。
 */
export const shouldSuppressNowPlayingEntry = (pathname: string | null): boolean =>
    pathname === NOW_PLAYING_COMPAT_ROUTE;

/**
 * @deprecated M6 路由工厂（M6 单测锁定 push('/player') 语义）。
 * M7 产品路径改用 createExpandedNowPlayingEntryController（store open）。
 */
export const createNowPlayingEntryController = (
    push: (url: string) => void,
    pathname: string | null
): NowPlayingEntryController => {
    const open = () => {
        if (shouldSuppressNowPlayingEntry(pathname)) {
            return;
        }
        push(NOW_PLAYING_COMPAT_ROUTE);
    };
    return {
        openDetails: open,
        openExpanded: open,
    };
};

/**
 * 纯工厂（M7，可独立测试）：给定 UI open 构造控制器。
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
