/**
 * NowPlaying UI Store（spec §4 / §4.1）。
 *
 * Expanded 是否打开是纯 UI state，与 Playback Domain 彻底独立：
 * - isExpanded = UI state；isPlaying = Playback state，两者生命周期独立；
 * - 本 store 只存 isExpanded + returnFocusTarget（spec §4 允许的额外字段）；
 * - 绝不存 session/playback 派生（由调用方经 selectors 读取）。
 *
 * 打开/关闭一律不改变播放状态（spec §9：open ≠ play，close ≠ pause）。
 * 自动关闭唯一条件由 NowPlayingLayer 消费 source/status 判定
 * （source == null 或 status == idle），本 store 自身不订阅播放状态。
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

/** NowPlaying UI 状态（仅 UI，不含任何播放派生）。 */
export type NowPlayingUiState = {
    /** Expanded 是否打开（全局唯一 UI 开关，不属于 route）。 */
    isExpanded: boolean;
    /**
     * 返回焦点目标（打开时捕获的触发元素，关闭时恢复）。
     * 仅为焦点管理持有，不参与任何播放/会话派生。
     */
    returnFocusTarget: HTMLElement | null;
    /**
     * 打开 Expanded（不改变播放状态，不创建 Session）。
     * @param target 可选显式触发元素；缺省时捕获 document.activeElement。
     */
    openExpanded: (target?: HTMLElement | null) => void;
    /** 关闭 Expanded（不暂停播放，不 clear Session）。 */
    closeExpanded: () => void;
};

/** body/documentElement 不算有效焦点捕获（WebKit 点击 button 不聚焦，activeElement 为 body）。 */
const isNonTriggerRoot = (el: HTMLElement | null): boolean => {
    if (!el) {
        return false;
    }
    try {
        if (typeof document !== 'undefined' && (el === document.body || el === document.documentElement)) {
            return true;
        }
        const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
        if (tag === 'BODY' || tag === 'HTML') {
            return true;
        }
    } catch {
        // tagName 读取异常视为非 root（调用方 fallback 兜底）。
    }
    return false;
};

const resolveFocusTarget = (explicit?: HTMLElement | null): HTMLElement | null => {
    if (explicit !== undefined) {
        if (explicit === null || isNonTriggerRoot(explicit)) {
            return null;
        }
        return explicit;
    }
    try {
        if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
            const captured = document.activeElement;
            if (isNonTriggerRoot(captured)) {
                return null;
            }
            return captured;
        }
    } catch {
        // SSR / jsdom 异常一律回退 null（调用方以 Mini trigger 为 fallback）。
    }
    return null;
};

export const useNowPlayingUiStore = create<NowPlayingUiState>()(
    devtools(
        (set) => ({
            isExpanded: false,
            returnFocusTarget: null,
            openExpanded: (target) =>
                set({
                    isExpanded: true,
                    returnFocusTarget: resolveFocusTarget(target),
                }),
            closeExpanded: () => set({ isExpanded: false }),
        }),
        { name: 'now-playing-ui-store' }
    )
);
