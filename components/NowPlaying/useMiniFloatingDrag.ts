'use client';

/**
 * M6-04 MiniNowPlaying Wide Floating 拖拽 hook（spec §18）。
 *
 * 冻结契约：
 * - 仅 wide-floating 生效（enabled=false 时不绑定手势、不输出坐标）；
 * - 初始位置纯 CSS（right:var(--space-4)；bottom:calc(tab-bar-safe-bottom + var(--space-4))），
 *   本 hook 初始 pos=null（无 JS 固定像素如 x:16,y:360 / innerHeight-280）；
 *   用户首次 drag 后才转为 left/top 内联坐标（data-dragged=true）；
 * - 仅 DragGrip 绑定 useDrag（@use-gesture/react ^10.3.1，filterTaps:true）；
 *   Playback Button 与 Metadata（open expanded）按钮均不参与 drag；
 * - drag 期间/结束 clamp 到 viewport 内；drag end 吸附 nearest 水平 edge，垂直保留；
 * - 监听 window.resize + visualViewport.resize → re-clamp 现有位置防出界；
 * - 位置仅当前浏览 session 内存保持（useState，不写 DB/UserConfig/localStorage，
 *   reload 回默认右下；本文件不得 import storage/DB/config 写面）；
 * - 纯 presentation：不 mutation session/transport 状态（不 import
 *   PlaybackSessionStore 写面/playbackSessionFlow/audioController，
 *   只做坐标 state + clamp/snap 纯函数委托）。
 *
 * Responsive 切换（spec §49/C）：pos 在 hook 内跨 mode 保留，但调用方仅在
 * wide-floating 时应用为 left/top；docked/compact 时不输出内联坐标，
 * 故旧 floating 坐标不参与 mobile layout；回 wide 时恢复合法位置
 * （resize repair 已 re-clamp，超界不会残留）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDrag } from '@use-gesture/react';

import {
    MINI_FLOATING_MARGIN_X_PX,
    clampFloatingPosition,
    resolveFloatingDragEnd,
    type MiniFloatingPosition,
} from './MiniFloatingGeometry';

export type { MiniFloatingPosition };

/** grip 绑定返回值（spread 到 DragGrip 元素）。 */
export type MiniFloatingGripBind = (
    ...args: unknown[]
) => Record<string, unknown>;

/** hook 返回：面板 ref + grip 绑定 + 坐标/拖拽态（仅 floating 时应用）。 */
export type MiniFloatingDrag = {
    /** 面板根节点 ref（measure 尺寸 + 初始 rect 捕获）。 */
    panelRef: React.RefObject<HTMLDivElement | null>;
    /** 仅 spread 到 DragGrip（Playback/Metadata 按钮不得 spread）。 */
    gripBind: MiniFloatingGripBind;
    /** null=默认 CSS 右下；非 null=用户已拖拽的 left/top（内存态）。 */
    position: MiniFloatingPosition | null;
    /** 是否正在拖拽（供 cursor/transition 打点）。 */
    isDragging: boolean;
};

/** 面板尺寸回退（measure 失败时）：与 --size-mini-now-playing-wide/height 对齐。 */
const FALLBACK_PANEL_WIDTH = 360;
const FALLBACK_PANEL_HEIGHT = 68;

const readViewport = (): { width: number; height: number } => ({
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
});

const readPanelSize = (
    el: HTMLDivElement | null
): { width: number; height: number } => {
    if (!el || typeof el.getBoundingClientRect !== 'function') {
        return { width: FALLBACK_PANEL_WIDTH, height: FALLBACK_PANEL_HEIGHT };
    }
    try {
        const rect = el.getBoundingClientRect();
        return {
            width:
                Number.isFinite(rect.width) && rect.width > 0
                    ? rect.width
                    : FALLBACK_PANEL_WIDTH,
            height:
                Number.isFinite(rect.height) && rect.height > 0
                    ? rect.height
                    : FALLBACK_PANEL_HEIGHT,
        };
    } catch {
        return { width: FALLBACK_PANEL_WIDTH, height: FALLBACK_PANEL_HEIGHT };
    }
};

/**
 * Wide Floating 拖拽 hook。
 * @param enabled 仅 wide-floating 为 true（其它 mode 下手势禁用、坐标保留但不应用）。
 */
export const useMiniFloatingDrag = (enabled: boolean): MiniFloatingDrag => {
    const [position, setPosition] = useState<MiniFloatingPosition | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const positionRef = useRef<MiniFloatingPosition | null>(null);
    positionRef.current = position;
    const enabledRef = useRef(enabled);
    enabledRef.current = enabled;

    // Resize repair（spec §18.4）：窗口缩小 re-clamp 现有位置防出界。
    // 无论当前是否为 floating 均 repair 保留坐标，保证回 wide 时合法（§49）。
    useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }
        const onResize = () => {
            const cur = positionRef.current;
            if (!cur) {
                return;
            }
            const viewport = readViewport();
            const panel = readPanelSize(panelRef.current);
            const clamped = clampFloatingPosition(cur.x, cur.y, viewport, panel);
            if (clamped.x !== cur.x || clamped.y !== cur.y) {
                setPosition(clamped);
            }
        };
        window.addEventListener('resize', onResize);
        const vv = window.visualViewport;
        vv?.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
            vv?.removeEventListener('resize', onResize);
        };
    }, []);

    const handleDrag = useCallback(
        (state: {
            first?: boolean;
            last?: boolean;
            active?: boolean;
            movement?: [number, number];
            memo?: MiniFloatingPosition | undefined;
        }) => {
            if (!enabledRef.current) {
                return undefined;
            }
            const movement = state.movement ?? [0, 0];
            // 首帧捕获起点：已有坐标即起点；否则以当前面板 rect 为视觉起点
            // （默认 CSS 右下 → left/top 的一次性转换，不依赖固定像素）。
            let start = state.memo;
            if (state.first || !start) {
                const cur = positionRef.current;
                if (cur) {
                    start = { ...cur };
                } else {
                    const el = panelRef.current;
                    try {
                        const rect = el?.getBoundingClientRect();
                        start =
                            rect && Number.isFinite(rect.left) && Number.isFinite(rect.top)
                                ? { x: rect.left, y: rect.top }
                                : { x: MINI_FLOATING_MARGIN_X_PX, y: MINI_FLOATING_MARGIN_X_PX };
                    } catch {
                        start = { x: MINI_FLOATING_MARGIN_X_PX, y: MINI_FLOATING_MARGIN_X_PX };
                    }
                }
            }
            if (state.first) {
                setIsDragging(true);
            }
            const viewport = readViewport();
            const panel = readPanelSize(panelRef.current);
            const nextX = start.x + movement[0];
            const nextY = start.y + movement[1];
            if (state.last) {
                setIsDragging(false);
                setPosition(resolveFloatingDragEnd(nextX, nextY, viewport, panel));
                return undefined;
            }
            if (state.active) {
                setPosition(clampFloatingPosition(nextX, nextY, viewport, panel));
            }
            // memo 透传起点（跨帧累积 movement 的基准）。
            return start;
        },
        []
    );

    const bind = useDrag(handleDrag, {
        filterTaps: true,
        enabled,
    } as Parameters<typeof useDrag>[1]);

    return {
        panelRef,
        gripBind: bind as unknown as MiniFloatingGripBind,
        position,
        isDragging,
    };
};
