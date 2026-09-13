/**
 * M6-03 MainChrome 可见性纯派生（spec §30）。
 *
 * 纯函数层：不 import 任何 store / router / DOM / GlassToast，
 * 只依赖 M6-02 同一 hasNowPlaying 公式，保证 reservation 与 slot 同源。
 * Hook 层见 useMainChromeState.ts（只做 selector 派生，不 mutation）。
 */

import { hasMiniNowPlaying } from '@/components/NowPlaying/deriveMiniNowPlayingViewModel';
import type {
    MiniNowPlayingLayoutMode,
    MiniSessionSnapshot,
} from '@/components/NowPlaying/types';

/** MainChrome 可见性纯输入（可独立测试，不依赖 store/hook）。 */
export type MainChromeVisibilityInput = {
    /** Session source（null 表示无可展示 session）。 */
    source: MiniSessionSnapshot['source'];
    /** Session status（含 idle/hydrating 等 M5 全量）。 */
    status: MiniSessionSnapshot['status'];
    /** 三态 layoutMode（M6-01 契约：767→compact-docked；768→wide-*）。 */
    layoutMode: MiniNowPlayingLayoutMode;
    /** 软键盘是否展开（useSoftKeyboardState().isOpen）。 */
    isKeyboardOpen: boolean;
};

/** MainChrome 可见性纯输出（reservation 与 slot 渲染的唯一依据）。 */
export type MainChromeVisibility = {
    /** 是否存在可展示 session（source 非空且非 idle）。 */
    hasNowPlaying: boolean;
    /** 键盘抑制（仅 compact-docked + open）。 */
    keyboardSuppressed: boolean;
    /** 是否渲染 Mini（hasNowPlaying && !keyboardSuppressed）。 */
    visible: boolean;
    /** 是否预留 docked 空间（visible && 非 wide-floating）。 */
    hasDockedMini: boolean;
    /** 是否为兼容浮层（visible && wide-floating，不占位）。 */
    hasFloatingMini: boolean;
};

/**
 * 纯函数：MainChrome 可见性派生（spec §30 M6-03 切面）。
 * 不读 store、不写 session、不触 audio，调用方（hook/单测）可独立验证。
 */
export const resolveMainChromeVisibility = (
    input: MainChromeVisibilityInput
): MainChromeVisibility => {
    const hasNowPlaying = hasMiniNowPlaying({
        source: input.source,
        status: input.status,
        // title/position 不进入显隐公式，占位即可（与 M6-02 同公式）。
        title: '',
        lastCompletedParagraphIndex: -1,
        nextParagraphIndex: 0,
        totalParagraphs: 1,
    });
    const keyboardSuppressed =
        input.layoutMode === 'compact-docked' && input.isKeyboardOpen;
    const visible = hasNowPlaying && !keyboardSuppressed;
    const hasDockedMini = visible && input.layoutMode !== 'wide-floating';
    const hasFloatingMini = visible && input.layoutMode === 'wide-floating';
    return {
        hasNowPlaying,
        keyboardSuppressed,
        visible,
        hasDockedMini,
        hasFloatingMini,
    };
};
