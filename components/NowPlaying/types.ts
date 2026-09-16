/**
 *  Mini Now Playing — Responsive & Keyboard Foundation 类型（）。
 *
 * 本项只落地契约类型与 detector 能力，不负责 Mini 显隐/渲染/MainChrome 结构。
 * - LayoutMode 派生：viewport <768 → compact-docked；>=768 + pref → wide-floating/wide-docked。
 * - Keyboard：移动端软键盘 open 时 compact Mini 抑制（抑制逻辑归后续 Slice，本项只提供 detector）。
 */

/**  冻结断点（px）：mobile/docked <768；desktop >=768。SCSS $breakpoint-lg 同值。 */
export const NOW_PLAYING_BREAKPOINT_PX = 768;

/** Viewport 粗模式：compact（<768）/ wide（>=768）。 */
export type NowPlayingViewportMode = 'compact' | 'wide';

/**
 * Mini 布局模式（ 正式三态）：
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

/* ------------------------------------------------------------------ */
/*  MiniNowPlaying Semantic Core（spec §3/§4/§5/§6/§9/§10/§33）。  */
/* 本节只加 presentation ViewModel 语义，不改  断点/键盘契约。      */
/* ViewModel 为纯 UI 表达：绝不进入 PlaybackSessionStore / playbackStore */
/* / Prisma；数据来源冻结见 deriveMiniNowPlayingViewModel.ts。          */
/* ------------------------------------------------------------------ */

/** Mini 空标题 defensive fallback（spec §5：仅此一处允许非 Session 标题）。 */
export const MINI_NOW_PLAYING_FALLBACK_TITLE = '正在播放';

/**
 * Mini 状态（spec §3 ViewModel.status 六态）：
 * ready / synthesizing / playing / paused / ended / error。
 * Session 侧 hydrating 映射为 synthesizing；idle 仅占位（visible=false 时不渲染）。
 */
export type MiniNowPlayingStatus =
    | 'ready'
    | 'synthesizing'
    | 'playing'
    | 'paused'
    | 'ended'
    | 'error';

/** Mini 主动作（spec §10）：play / pause / restart / retry / disabled。 */
export type MiniPlaybackAction = 'play' | 'pause' | 'restart' | 'retry' | 'disabled';

/**
 * Mini Session 快照（ 冻结来源：仅 PlaybackSessionStore.current session）。
 * - title 仅取 Session.title（spec §5）；
 * - position 仅取 Session 语义位置（spec §4/§8）；
 * - source/status/sessionId 仅取 Session（spec §2.3/§30）。
 * Mini 绝不读取 legacy playbackProgressStore / GenerationHistory / StoryCard。
 */
export type MiniSessionSnapshot = {
    /** 当前 session source（null 表示无可展示 session）。 */
    source: { kind: 'draft' | 'work' } | null;
    /** Session 状态（含  全量，derive 内映射为 ViewModel 六态）。 */
    status:
        | 'idle'
        | 'hydrating'
        | 'ready'
        | 'synthesizing'
        | 'playing'
        | 'paused'
        | 'ended'
        | 'error';
    /** Session 标题（ StoryWork.title 或 Draft 快照 title）。 */
    title: string;
    /** 已完成段落下标（初始 -1）。 */
    lastCompletedParagraphIndex: number;
    /** 下一待播段落下标（0-based）。 */
    nextParagraphIndex: number;
    /** 总段落数（>=1）。 */
    totalParagraphs: number;
};

/**
 * Mini Transport 快照（ 冻结来源：仅 playbackStore / Transport）。
 * 只含播放/暂停与当前段时间进度；remainingMs 不在 Mini 展示（spec §7）。
 */
export type MiniTransportSnapshot = {
    /** Transport 是否正在播放（audio element 实际出声态）。 */
    isPlaying: boolean;
    /** 当前段时间进度（秒）。 */
    currentTime: number;
    /** 当前段时间总时长（秒，0 表示未知）。 */
    duration: number;
};

/**
 * MiniNowPlaying 纯 UI ViewModel（spec §3）。
 * visible 仅由 Session 派生（spec §2.3/§30）；layoutMode 仅决定形态，不决定存在性。
 * coarseProgress 为 paragraph-weighted 近似（spec §8.1），不可 seek，不展示精确时间/百分比。
 */
export type MiniNowPlayingViewModel = {
    /** 是否渲染 Mini（hasNowPlaying； 不含键盘/Expanded 抑制，那是）。 */
    visible: boolean;
    /** 一级标题：Session.title（空时回退“正在播放”）。 */
    title: string;
    /** 六态展示状态。 */
    status: MiniNowPlayingStatus;
    /** 二级文案（spec §6 deriveMiniSecondaryLabel）。 */
    secondaryLabel: string | null;
    /** 粗进度 0..1（visible 时恒有值；不可 seek）。 */
    coarseProgress: number | null;
    /** 主动作（spec §10 deriveMiniPlaybackAction）。 */
    primaryAction: MiniPlaybackAction;
    /** 布局形态三态（ 契约；config 只影响此字段，不影响 visible）。 */
    layoutMode: MiniNowPlayingLayoutMode;
};

/* ------------------------------------------------------------------ */
/*  Expanded  Playback Capabilities（spec §16/§17/§20/§39）。   */
/* 本节只加  类型契约，不改 / 既有类型；SSOT 仍在。        */
/* - Title/Voice/Play/Pause 一律走  ownership（UI→flow→Session+Host）；*/
/* - Timeline 恒 segment（当前 Segment，不伪装整篇）；                  */
/* - 两种 position 严格区分：paragraph identity → Session，段内         */
/*   currentTime/duration → Transport；                                 */
/* - 明确无上一段/下一段（spec §40），无 story-level timeline（）。*/
/* ------------------------------------------------------------------ */

/**   timeline 固定模式（ 前恒 segment）。 */
export type ExpandedTimelineMode = 'segment';

/**   键盘步进（秒，spec §17.2 ±5s）。 */
export const EXPANDED_SEEK_STEP_SECONDS = 5;

/**  七档倍速值（spec §20，与旧 AudioPlayer 一致）。 */
export const EXPANDED_SUPPORTED_PLAYBACK_RATES = [0.8, 0.9, 0.95, 1.0, 1.05, 1.1, 1.5] as const;

/**  七档倍速值类型。 */
export type ExpandedSupportedPlaybackRate = (typeof EXPANDED_SUPPORTED_PLAYBACK_RATES)[number];
