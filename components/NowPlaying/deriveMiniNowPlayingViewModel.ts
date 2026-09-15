/**
 * M6-02 MiniNowPlaying ViewModel 纯派生（spec §2.3/§3/§4/§5/§6/§8.1/§10/§30/§33）。
 *
 * 冻结数据来源：
 * - title → PlaybackSessionStore.session.title（空回退“正在播放”，spec §5）；
 * - session status/source/position → PlaybackSessionStore（spec §4）；
 * - 播放/暂停与当前段时间进度 → playbackStore / Transport（currentTime/duration/isPlaying）；
 * - remainingMs → Mini 不展示（spec §7，本文件绝不读取该字段）；
 * - layoutMode → 调用方传入（M6-01 三态契约），只决定形态，不决定存在性。
 *
 * 本文件为纯函数层：不 import 任何 store / Prisma / router /
 * legacy playbackProgressStore / GenerationHistory / StoryCard。
 * Mini 自身只做 presentation + Flow action delegation（见 MiniNowPlaying.tsx）。
 */

import {
    MINI_NOW_PLAYING_FALLBACK_TITLE,
    type MiniNowPlayingLayoutMode,
    type MiniNowPlayingStatus,
    type MiniNowPlayingViewModel,
    type MiniPlaybackAction,
    type MiniSessionSnapshot,
    type MiniTransportSnapshot,
} from './types';

export type {
    MiniNowPlayingLayoutMode,
    MiniNowPlayingStatus,
    MiniNowPlayingViewModel,
    MiniPlaybackAction,
    MiniSessionSnapshot,
    MiniTransportSnapshot,
};
export { MINI_NOW_PLAYING_FALLBACK_TITLE };

/**
 * 显隐派生（spec §2.3/§30 M6-02 切面）：
 * hasNowPlaying = source !== null && status !== 'idle'。
 * config.desktopFloatingPlayerEnabled 不进入此公式（只影响 layoutMode）。
 * 键盘/Expanded 抑制归 M6-03 App Chrome，本纯函数不引入。
 */
export const hasMiniNowPlaying = (session: MiniSessionSnapshot): boolean =>
    session.source !== null && session.status !== 'idle';

/**
 * 标题派生（spec §5）：title = Session.title；空/全空白回退“正在播放”。
 * 不允许 prompt.slice / 读取 M2 / 展示 remainingMs / 段落文案上移为标题。
 */
export const deriveMiniTitle = (session: MiniSessionSnapshot): string => {
    const raw = typeof session.title === 'string' ? session.title.trim() : '';
    return raw.length > 0 ? session.title : MINI_NOW_PLAYING_FALLBACK_TITLE;
};

/**
 * Session 状态 → ViewModel 六态映射（spec §3）。
 * hydrating（M5 水合中）映射为 synthesizing（Loading/disabled）；
 * idle 仅占位映射为 ready（visible=false 时不渲染，值不进入 DOM）。
 */
export const mapSessionStatusToMiniStatus = (
    status: MiniSessionSnapshot['status']
): MiniNowPlayingStatus => {
    if (status === 'hydrating') {
        return 'synthesizing';
    }
    if (status === 'idle') {
        return 'ready';
    }
    return status;
};

/**
 * Secondary Label 纯派生（spec §6）：
 * synthesizing → 正在准备语音；error → 播放遇到问题；ended → 播放完成；
 * 多段 → 第 X / Y 段（X = nextParagraphIndex+1，钳制 1..total）；
 * 单段 playing → 正在播放；单段 paused/ready → 已暂停。
 * Draft / Work 不做视觉分叉（spec §33）。
 */
export const deriveMiniSecondaryLabel = (session: MiniSessionSnapshot): string | null => {
    const status = mapSessionStatusToMiniStatus(session.status);
    if (status === 'synthesizing') {
        return '正在准备语音';
    }
    if (status === 'error') {
        return '播放遇到问题';
    }
    if (status === 'ended') {
        return '播放完成';
    }
    const total = Number.isFinite(session.totalParagraphs) && session.totalParagraphs > 0
        ? Math.floor(session.totalParagraphs)
        : 1;
    if (total > 1) {
        const rawNext = Number.isFinite(session.nextParagraphIndex)
            ? Math.floor(session.nextParagraphIndex)
            : 0;
        const display = Math.min(Math.max(rawNext + 1, 1), total);
        return `第 ${display} / ${total} 段`;
    }
    if (status === 'playing') {
        return '正在播放';
    }
    return '已暂停';
};

/**
 * Primary Action 纯派生（spec §10）：
 * playing → pause；ready/paused → play；ended → restart；
 * error → retry；synthesizing → disabled。
 */
export const deriveMiniPlaybackAction = (
    status: MiniSessionSnapshot['status']
): MiniPlaybackAction => {
    if (status === 'idle') {
        return 'disabled';
    }
    const mini = mapSessionStatusToMiniStatus(status);
    if (mini === 'playing') {
        return 'pause';
    }
    if (mini === 'ready' || mini === 'paused') {
        return 'play';
    }
    if (mini === 'ended') {
        return 'restart';
    }
    if (mini === 'error') {
        return 'retry';
    }
    return 'disabled';
};

/** 数值钳制（paragraph rail 专用，不复用 MiniFloatingGeometry 拖拽钳制）。 */
const clamp01 = (value: number): number => {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(1, Math.max(0, value));
};

/**
 * 粗进度纯派生（spec §8.1 paragraph-weighted approximation）：
 * completed = lastCompletedParagraphIndex + 1；
 * segmentFraction = duration>0 ? currentTime/duration : 0；
 * coarse = clamp((completed + segmentFraction) / total, 0, 1)。
 * 非交互、非 seek；UI 不展示百分比/精确时间（由 presentation 层保证）。
 */
export const deriveMiniCoarseProgress = (
    session: MiniSessionSnapshot,
    transport: MiniTransportSnapshot
): number | null => {
    if (!hasMiniNowPlaying(session)) {
        return null;
    }
    const total = Number.isFinite(session.totalParagraphs) && session.totalParagraphs > 0
        ? Math.floor(session.totalParagraphs)
        : 1;
    const completed = Number.isFinite(session.lastCompletedParagraphIndex)
        ? Math.floor(session.lastCompletedParagraphIndex) + 1
        : 0;
    const safeCompleted = Math.min(Math.max(completed, 0), total);
    let fraction = 0;
    if (
        Number.isFinite(transport.currentTime) &&
        Number.isFinite(transport.duration) &&
        transport.duration > 0
    ) {
        fraction = clamp01(transport.currentTime / transport.duration);
    }
    return clamp01((safeCompleted + fraction) / total);
};

/**
 * ViewModel 总装（spec §3）：visible + title + status + secondaryLabel +
 * coarseProgress + primaryAction + layoutMode（透传）。
 * remainingMs 不进入本结构（spec §7），调用方不得传入。
 */
export const deriveMiniNowPlayingViewModel = (
    session: MiniSessionSnapshot,
    transport: MiniTransportSnapshot,
    layoutMode: MiniNowPlayingLayoutMode
): MiniNowPlayingViewModel => {
    const visible = hasMiniNowPlaying(session);
    return {
        visible,
        title: deriveMiniTitle(session),
        status: mapSessionStatusToMiniStatus(session.status),
        secondaryLabel: visible ? deriveMiniSecondaryLabel(session) : null,
        coarseProgress: deriveMiniCoarseProgress(session, transport),
        primaryAction: deriveMiniPlaybackAction(session.status),
        layoutMode,
    };
};
