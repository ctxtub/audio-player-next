'use client';

/**
 * M6-02 NowPlaying Entry Facade（spec §23/§24/§25）。
 *
 * Mini 只调用 openDetails()/openExpanded()，不直接 router.push 写死。
 * M6 实现：openDetails/openExpanded → router.push('/player')（M1 compatibility exception）；
 * M7 只替换本 facade 内部实现为 Expanded UI open，Mini Component 无需修改。
 * /player 上 no-op（spec §24.1，避免重复 push 相同 URL）。
 */

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter } from 'next/navigation';

/** NowPlaying 入口控制器（M6：路由兼容；M7：Expanded UI）。 */
export type NowPlayingEntryController = {
    /** 打开详情（M6 → /player；M7 → Expanded）。 */
    openDetails: () => void;
    /** 打开 Expanded（M6 → /player；M7 → Expanded；与 openDetails 同义，满足命名迁移契约）。 */
    openExpanded: () => void;
};

/** /player 路由常量（精确字符串，单测锁定）。 */
export const NOW_PLAYING_COMPAT_ROUTE = '/player';

/**
 * 纯判定：当前 pathname 是否应抑制 entry push（spec §24.1）。
 * 已在 /player → no-op，不重复写 history。
 */
export const shouldSuppressNowPlayingEntry = (pathname: string | null): boolean =>
    pathname === NOW_PLAYING_COMPAT_ROUTE;

/**
 * 纯工厂（可独立测试）：给定 push 与 pathname 构造控制器。
 * push 必须精确以 '/player' 调用；抑制时不调用。
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
 * Entry hook：绑定 Next App Router。
 * Mini Metadata 区域 onClick 只调 openDetails()/openExpanded()，不感知路由/Expanded 形态。
 */
export const useNowPlayingEntry = (): NowPlayingEntryController => {
    const router = useRouter();
    const pathname = usePathname();

    const push = useCallback(
        (url: string) => {
            router.push(url);
        },
        [router]
    );

    return useMemo(
        () => createNowPlayingEntryController(push, pathname),
        [push, pathname]
    );
};
