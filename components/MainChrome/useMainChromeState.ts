'use client';

/**
 * M6-03 MainChrome 状态 hook（spec §15/§16/§30）。
 *
 * 纯派生见 ./visibility.ts（单测直引纯层，不触 store）。
 * 本文件只做 selector 派生，不 mutation
 * PlaybackSessionStore.sessionId/status/source/continuationMode，
 * 不 clear Session、不 pause、不写 Anchor、不写第二套显隐标记
 * （M5 owner 边界：动作一律走 playbackSessionFlow，见 MiniNowPlaying）。
 */

import { useNowPlayingLayoutMode } from '@/components/NowPlaying/useNowPlayingLayoutMode';
import type { MiniNowPlayingLayoutMode } from '@/components/NowPlaying/types';
import { useSoftKeyboardState } from '@/components/NowPlaying/useSoftKeyboardState';
import { useConfigStore } from '@/stores/configStore';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';

import {
    resolveMainChromeVisibility,
    type MainChromeVisibility,
    type MainChromeVisibilityInput,
} from './visibility';

export type { MainChromeVisibility, MainChromeVisibilityInput };
export { resolveMainChromeVisibility };

/** MainChrome hook 状态（含 layoutMode 与键盘原始信号，供渲染打点）。 */
export type MainChromeState = MainChromeVisibility & {
    /** 三态 layoutMode（透传，供 data-layoutmode 打点与 off-by-one 断言）。 */
    layoutMode: MiniNowPlayingLayoutMode;
    /** 软键盘原始信号（透传，供调试与单测mock对齐）。 */
    isKeyboardOpen: boolean;
};

/**
 * MainChrome 状态 hook：只做 selector 派生，不 mutation Session。
 * - source/status 仅订阅（不 set）；
 * - desktopFloatingPlayerEnabled 只决定 layoutMode，不决定存在性；
 * - keyboard 只决定 visibility（纯隐藏，播放/Anchor 不动）。
 */
export const useMainChromeState = (): MainChromeState => {
    const source = usePlaybackSessionStore((state) => state.source);
    const status = usePlaybackSessionStore((state) => state.status);
    const desktopFloatingPlayerEnabled = useConfigStore(
        (state) => state.apiConfig.desktopFloatingPlayerEnabled
    );
    const layoutMode = useNowPlayingLayoutMode(desktopFloatingPlayerEnabled);
    const { isOpen: isKeyboardOpen } = useSoftKeyboardState();

    const visibility = resolveMainChromeVisibility({
        source,
        status,
        layoutMode,
        isKeyboardOpen,
    });

    return {
        ...visibility,
        layoutMode,
        isKeyboardOpen,
    };
};
