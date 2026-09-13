/**
 * M6-04 NowPlaying 正式 import surface（命名迁移收官 + FIXUP：
 * FloatingPlayer 仅留 deprecated 兼容 shim，见 components/FloatingPlayer/index.tsx，M9 删除）。
 */

export { MiniNowPlaying, default } from './MiniNowPlaying';
export {
    deriveMiniCoarseProgress,
    deriveMiniNowPlayingViewModel,
    deriveMiniPlaybackAction,
    deriveMiniSecondaryLabel,
    deriveMiniTitle,
    hasMiniNowPlaying,
    mapSessionStatusToMiniStatus,
} from './deriveMiniNowPlayingViewModel';
export { MiniMetadataButton, MiniPlaybackButton, MiniProgressRail } from './presentation';
export {
    NOW_PLAYING_COMPAT_ROUTE,
    createNowPlayingEntryController,
    shouldSuppressNowPlayingEntry,
    useNowPlayingEntry,
    type NowPlayingEntryController,
} from './useNowPlayingEntry';
export {
    NOW_PLAYING_BREAKPOINT_PX,
    resolveNowPlayingLayoutMode,
    resolveViewportMode,
    useNowPlayingLayoutMode,
    useViewportMode,
    type MiniNowPlayingLayoutMode,
    type NowPlayingViewportMode,
} from './useNowPlayingLayoutMode';
export { shouldTreatAsKeyboardOpen, useSoftKeyboardState } from './useSoftKeyboardState';
export {
    MINI_FLOATING_MARGIN_X_PX,
    MINI_FLOATING_MARGIN_Y_PX,
    clampFloatingPosition,
    resolveFloatingDragEnd,
    resolveFloatingSnapSide,
    snapFloatingToEdge,
    type MiniFloatingPanelSize,
    type MiniFloatingPosition,
    type MiniFloatingSnapSide,
    type MiniFloatingViewportSize,
} from './MiniFloatingGeometry';
export { useMiniFloatingDrag, type MiniFloatingDrag } from './useMiniFloatingDrag';
export {
    MINI_NOW_PLAYING_FALLBACK_TITLE,
    NOW_PLAYING_BREAKPOINT_PX as NOW_PLAYING_BREAKPOINT_PX_FROM_TYPES,
    type MiniNowPlayingStatus,
    type MiniNowPlayingViewModel,
    type MiniPlaybackAction,
    type MiniSessionSnapshot,
    type MiniTransportSnapshot,
    type SoftKeyboardSignal,
    type SoftKeyboardState,
} from './types';
