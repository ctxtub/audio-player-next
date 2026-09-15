/**
 * M6-04 MiniNowPlaying Wide Floating 几何纯函数（spec §18.3/§18.4）。
 *
 * 职责：
 * - drag 期间/结束 clamp 到 viewport 内；
 * - drag end 吸附 nearest 水平 edge（left/right），垂直保留；
 * - resize 缩窗 re-clamp（调用方监听 window.resize + visualViewport.resize）。
 *
 * 本文件为纯函数层：不 import 任何 store / router / DOM /
 * localStorage / DB / UserConfig；位置持久化由 useMiniFloatingDrag 经
 * localStorage 完成（localStorage 持久化 + refresh restore），本层仅提供
 * clamp/snap 纯函数（调用方负责读写与容错）。
 * 边距与 CSS token 对齐：水平 16px = var(--space-4)（初始 right:var(--space-4) 与
 * 吸附边距同源）；垂直 8px = var(--space-2)（最小可视保留，不复刻 tab-bar 高度，
 * floating 为 viewport overlay，不参与 BottomChrome 预留）。
 */

/** 浮窗水平边距（px）：与 CSS `right: var(--space-4)` 同源（--space-4=16px）。 */
export const MINI_FLOATING_MARGIN_X_PX = 16;

/** 浮窗垂直最小保留（px）：与 var(--space-2)=8px 同源，保证完全可见。 */
export const MINI_FLOATING_MARGIN_Y_PX = 8;

/** 浮窗坐标（viewport 左上为原点的 left/top，单位 px）。 */
export type MiniFloatingPosition = {
    x: number;
    y: number;
};

/** 浮窗面板尺寸（measure 自 getBoundingClientRect）。 */
export type MiniFloatingPanelSize = {
    width: number;
    height: number;
};

/** 视口尺寸。 */
export type MiniFloatingViewportSize = {
    width: number;
    height: number;
};

/** 吸附边：left / right（仅水平，垂直保留）。 */
export type MiniFloatingSnapSide = 'left' | 'right';

/**
 * 钳制浮窗坐标到 viewport 内（drag 期间/结束/resize 通用）。
 * 面板宽高非法/缺失时回退为 0（不放大钳制区间）。
 */
export const clampFloatingPosition = (
    x: number,
    y: number,
    viewport: MiniFloatingViewportSize,
    panel: MiniFloatingPanelSize,
    marginX: number = MINI_FLOATING_MARGIN_X_PX,
    marginY: number = MINI_FLOATING_MARGIN_Y_PX
): MiniFloatingPosition => {
    const safeX = Number.isFinite(x) ? x : marginX;
    const safeY = Number.isFinite(y) ? y : marginY;
    const vw = Number.isFinite(viewport.width) ? viewport.width : 0;
    const vh = Number.isFinite(viewport.height) ? viewport.height : 0;
    const pw = Number.isFinite(panel.width) && panel.width > 0 ? panel.width : 0;
    const ph = Number.isFinite(panel.height) && panel.height > 0 ? panel.height : 0;
    // 视口小于面板时 max 回退为 margin（左上对齐，至少保留一边可见，不抛非法坐标）。
    const maxX = Math.max(marginX, vw - pw - marginX);
    const maxY = Math.max(marginY, vh - ph - marginY);
    return {
        x: Math.min(maxX, Math.max(marginX, safeX)),
        y: Math.min(maxY, Math.max(marginY, safeY)),
    };
};

/**
 * 判定吸附边：面板水平中心相对视口中心（spec §18.3 nearest horizontal edge）。
 * 中线（含）偏右即 right，保证确定性（无随机/抖动）。
 */
export const resolveFloatingSnapSide = (
    x: number,
    viewportWidth: number,
    panelWidth: number
): MiniFloatingSnapSide => {
    const safeX = Number.isFinite(x) ? x : 0;
    const vw = Number.isFinite(viewportWidth) ? viewportWidth : 0;
    const pw = Number.isFinite(panelWidth) && panelWidth > 0 ? panelWidth : 0;
    return safeX + pw / 2 < vw / 2 ? 'left' : 'right';
};

/**
 * 吸附到最近水平边（spec §18.3）：x 贴边，y 原样保留。
 * 调用方应在 snap 前已 clamp y（本函数不改 y，不做垂直吸附）。
 */
export const snapFloatingToEdge = (
    x: number,
    y: number,
    viewportWidth: number,
    panelWidth: number,
    marginX: number = MINI_FLOATING_MARGIN_X_PX
): MiniFloatingPosition => {
    const side = resolveFloatingSnapSide(x, viewportWidth, panelWidth);
    const vw = Number.isFinite(viewportWidth) ? viewportWidth : 0;
    const pw = Number.isFinite(panelWidth) && panelWidth > 0 ? panelWidth : 0;
    const snappedX =
        side === 'left' ? marginX : Math.max(marginX, vw - pw - marginX);
    return { x: snappedX, y };
};

/**
 * drag end 终态：先 clamp（防出界）再水平吸附（垂直保留）。
 * resize repair 仅用 clampFloatingPosition（不吸附，避免窗口变化时横跳）。
 */
export const resolveFloatingDragEnd = (
    x: number,
    y: number,
    viewport: MiniFloatingViewportSize,
    panel: MiniFloatingPanelSize,
    marginX: number = MINI_FLOATING_MARGIN_X_PX,
    marginY: number = MINI_FLOATING_MARGIN_Y_PX
): MiniFloatingPosition => {
    const clamped = clampFloatingPosition(x, y, viewport, panel, marginX, marginY);
    return snapFloatingToEdge(
        clamped.x,
        clamped.y,
        viewport.width,
        panel.width,
        marginX
    );
};
