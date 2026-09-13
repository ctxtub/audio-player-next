/**
 * M6 Mini Now Playing — Responsive & Keyboard Foundation 类型（M6-01）。
 *
 * 本项只落地契约类型与 detector 能力，不负责 Mini 显隐/渲染/MainChrome 结构。
 * - LayoutMode 派生：viewport <768 → compact-docked；>=768 + pref → wide-floating/wide-docked。
 * - Keyboard：移动端软键盘 open 时 compact Mini 抑制（抑制逻辑归后续 Slice，本项只提供 detector）。
 */

/** M6 冻结断点（px）：mobile/docked <768；desktop >=768。SCSS $breakpoint-lg 同值。 */
export const NOW_PLAYING_BREAKPOINT_PX = 768;

/** Viewport 粗模式：compact（<768）/ wide（>=768）。 */
export type NowPlayingViewportMode = 'compact' | 'wide';

/**
 * Mini 布局模式（M6 正式三态）：
 * - compact-docked：移动端固定 TabBar 上方，不可拖动；
 * - wide-docked：桌面偏好关闭，固定 TabBar 上方，不可拖动；
 * - wide-floating：桌面偏好开启，可拖动悬浮。
 */
export type MiniNowPlayingLayoutMode = 'compact-docked' | 'wide-docked' | 'wide-floating';

/** 软键盘 detector 状态：open/closed 可独立测试（本项不做 Mini 显隐）。 */
export type SoftKeyboardState = {
    /** 软键盘是否展开。 */
    isOpen: boolean;
};

/** 软键盘 detector 纯判定输入（供单测独立验证，不依赖真实键盘）。 */
export type SoftKeyboardSignal = {
    /** 当前聚焦元素是否为可编辑元素（input/textarea/contenteditable）。 */
    isEditableFocused: boolean;
    /** visualViewport 高度（不支持时为 null，走 fallback）。 */
    visualViewportHeight: number | null;
    /** layout viewport 高度（window.innerHeight）。 */
    layoutHeight: number;
    /** 是否存在 visualViewport API。 */
    hasVisualViewport: boolean;
};
