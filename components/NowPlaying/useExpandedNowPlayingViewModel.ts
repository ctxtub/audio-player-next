'use client';

/**
 * M7-01 Expanded ViewModel（spec §14 P3A 基础切面）。
 *
 * M7-01 只落地 Header/Surface 所需最小派生（title / voice / paragraph /
 * sessionStatus / source / transport 段进度 + 完成态），不复制 Store：
 * - title → PlaybackSessionStore.title（空回退“正在播放”，与 Mini 同公式）；
 * - voiceLabel → Session.voiceId 经 config voiceOptions lookup，
 *   找不到直接显示 voiceId，再 fallback“AI 语音”（spec §15）；
 * - paragraph → Session.nextParagraphIndex/totalParagraphs（P3A 段定位）；
 * - timeline P3A segment 形态与 sleepTimer/rate/actions 留给 M7-B/C/D，
 *   本文件不引入第二套播放状态。
 *
 * M7-02 P3A 增补（spec §14/§16/§17/§20/§39 additive，不破 M7-01 字段）：
 * - timeline 恒 segment（当前 Segment，不伪装整篇，spec §17/§68）；
 * - playbackRate = Session.speed（当前 Session 级，spec §20.1）；
 * - primaryAction/canRestart/isPlaying（与 Mini 同映射，Mini/Expanded 同 Session 即时同步）。
 *
 * M7-03 P3C 增补（spec §22/§32 additive，不破 M7-01/M7-02 字段）：
 * - sleepTimer = Session.sleepTimerMode + Transport.remainingMs + isWork
 *  （story_end 选项门；展示见 SleepTimerControl）。
 *
 * M7-04-01 Work 查看正文增补（spec §33-§34 additive，不破既有字段）：
 * - canViewStory/viewStoryTarget = source.workId 直接派生（`/library/${workId}`），
 *   Draft/空 source 一律隐藏（绝不拼凑目标）；同 Detail 去重由调用方经
 *   isSameLibraryDetail 判定（只 close，不重复 push）。
 *
 * M7-04-02 Draft Transcript 增补（spec §35/§72 additive，不破既有字段）：
 * - transcriptText/canViewTranscript = Draft source + Session.storyText
 *   直接派生（只读原文；无正文/Work/空/idle 一律隐藏，fail-closed）；
 *   controls ↔ transcript 切换由 Expanded 局部 useState 持有，不进
 *   global UI Store；promotion 成功（source 切 work，sessionId 不变）不强制
 *   关闭 transcript（调用方不因 source 变化重置局部 view）。
 *
 * 纯派生见 deriveExpandedNowPlayingViewModel（可独立测试）；
 * Hook 层只做 selector 派生，不 mutation Session/Transport/Config。
 */

import { useConfigStore } from '@/stores/configStore';
import { usePlaybackSessionStore, type PlaybackSessionStatus } from '@/stores/playbackSessionStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import type { PlaybackSourceRef } from '@/lib/playback/source';
import type { VoiceOption } from '@/types/ttsGenerate';
import { MINI_NOW_PLAYING_FALLBACK_TITLE } from './types';
import { deriveExpandedPlaybackAction, type ExpandedPlaybackAction } from './PlaybackControls';
import { EXPANDED_TIMELINE_MODE } from './PlaybackTimeline';
import { isValidSleepTimerMode, type SleepTimerMode } from '@/lib/playback/sleepTimer';
import { resolveWorkLibraryTarget } from './workViewStoryNavigation';
import { resolveDraftTranscriptText, resolveTranscriptDisplayText } from './draftTranscript';

export type { ExpandedPlaybackAction };
export { deriveExpandedPlaybackAction };
export { EXPANDED_TIMELINE_MODE };

/** Expanded 段落定位（P3A：当前段为最重要的作品级定位，spec §39）。 */
export type ExpandedParagraphViewModel = {
    /** 1-based 当前段展示序号（钳制 1..total）。 */
    current: number;
    /** 总段数（>=1）。 */
    total: number;
};

/** Expanded Transport 快照（P3A 当前 Segment 进度，不伪装整篇）。 */
export type ExpandedTransportViewModel = {
    isPlaying: boolean;
    currentTime: number;
    duration: number;
};

/** M7-01 Expanded ViewModel（Header/Surface 最小集 + M7-02 P3A 增补）。 */
export type ExpandedNowPlayingViewModel = {
    /** M7-04-02 当前 Session id（transcript 局部 view 重置键；promotion 同 id 保持打开）。 */
    sessionId: string | null;
    /** 是否存在可展示 session（source 非空且 status 非 idle）。 */
    hasSession: boolean;
    /** 一级标题（Session.title，空回退“正在播放”）。 */
    title: string;
    /** 语音标签（Session.voiceId → lookup → fallback）。 */
    voiceLabel: string;
    /** M5 Session 状态原样透传（pause/ended/error 均不自动关闭，spec §8）。 */
    sessionStatus: PlaybackSessionStatus;
    /** M5 source 原样透传（null → Layer 自动关闭）。 */
    source: PlaybackSourceRef | null;
    /** 段落定位。 */
    paragraph: ExpandedParagraphViewModel;
    /** P3A 当前段进度。 */
    transport: ExpandedTransportViewModel;
    /** 是否为完成态（status == ended，spec §8 保留展示）。 */
    isEnded: boolean;
    /** M7-02 P3A timeline（恒 segment，不伪装整篇）。 */
    timeline: ExpandedTimelineViewModel;
    /** M7-02 当前 Session 倍速（Session.speed，spec §20.1）。 */
    playbackRate: number;
    /** M7-02 主动作（与 Mini 同映射）。 */
    primaryAction: ExpandedPlaybackAction;
    /** M7-02 是否可从头播放（hasSession 即 true）。 */
    canRestart: boolean;
    /** M7-02 Transport 是否正在播放（Mini/Expanded 同源即时同步）。 */
    isPlaying: boolean;
    /** M7-03 当前 Session Sleep Timer（mode+remaining+isWork，spec §32）。 */
    sleepTimer: ExpandedSleepTimerViewModel;
    /** M7-04-01 是否展示查看正文（Work 合法目标存在，spec §34）。 */
    canViewStory: boolean;
    /** M7-04-01 查看正文 Library 目标（source.workId 直接派生；其余 null）。 */
    viewStoryTarget: string | null;
    /** M7-04-02 是否展示 Draft 查看正文入口（Draft + storyText 可用，spec §35）。 */
    canViewTranscript: boolean;
    /** M7-04-02 Draft 只读正文（Session.storyText 原文；不可用时 null，promotion 后仍展示）。 */
    transcriptText: string | null;
};

/** M7-03 Expanded SleepTimer ViewModel（spec §32；纯展示派生，不复制 Timer 状态）。 */
export type ExpandedSleepTimerViewModel = {
    /** 当前三态（Session.sleepTimerMode）。 */
    mode: SleepTimerMode;
    /** minutes 剩余毫秒（Transport.remainingMs；off/story_end 为 null）。 */
    remainingMs: number | null;
    /** 是否为 Work（story_end 选项门，§22.1）。 */
    isWork: boolean;
};
/** M7-02 P3A timeline ViewModel（恒 segment）。 */
export type ExpandedTimelineViewModel = {
    mode: typeof EXPANDED_TIMELINE_MODE;
    /** 段内当前时间（秒，已消毒 >=0）。 */
    currentTime: number;
    /** 段内总时长（秒，0 表示未知/fail-safe）。 */
    duration: number;
};

/** Session 快照输入（纯函数层，不依赖 store）。 */
export type ExpandedSessionSnapshot = {
    source: PlaybackSourceRef | null;
    status: PlaybackSessionStatus;
    title: string;
    voiceId: string;
    nextParagraphIndex: number;
    totalParagraphs: number;
    /** M7-04-02 当前 Session id（缺省 null，保持旧调用兼容）。 */
    sessionId?: string | null;
    /** M7-02 当前 Session 倍速（缺省 1.0，保持 M7-01 调用兼容）。 */
    speed?: number;
    /** M7-03 当前 Session Sleep Timer 三态（缺省 off，保持旧调用兼容）。 */
    sleepTimerMode?: SleepTimerMode;
    /** M7-04-02 当前 Session 正文（缺省空，保持旧调用兼容；唯一来源 Session.storyText）。 */
    storyText?: string;
};

/** Transport 快照输入（纯函数层）。 */
export type ExpandedTransportSnapshot = {
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    /** M7-02 Transport.playbackRate（纯函数回退用，缺省 1.0，保持三参兼容）。 */
    playbackRate?: number;
    /** M7-03 Transport.remainingMs（minutes 剩余；缺省 null，保持旧调用兼容）。 */
    remainingMs?: number | null;
};

/** 空标题回退（与 Mini 同一 fallback，保证跨 surface 一致）。 */
export const EXPANDED_NOW_PLAYING_FALLBACK_TITLE = MINI_NOW_PLAYING_FALLBACK_TITLE;

/** 语音未知时的最终回退（spec §15）。 */
export const EXPANDED_VOICE_FALLBACK_LABEL = 'AI 语音';

/**
 * 纯函数：语音标签派生（spec §15）。
 * Session.voiceId → voiceOptions lookup → 直接显示 voiceId → AI 语音。
 */
export const deriveExpandedVoiceLabel = (
    voiceId: string,
    voiceOptions: ReadonlyArray<Pick<VoiceOption, 'value' | 'label'>>
): string => {
    const raw = typeof voiceId === 'string' ? voiceId.trim() : '';
    if (raw.length === 0) {
        return EXPANDED_VOICE_FALLBACK_LABEL;
    }
    const matched = voiceOptions.find((option) => option.value === raw);
    if (matched && typeof matched.label === 'string' && matched.label.trim().length > 0) {
        return matched.label;
    }
    return raw;
};

/**
 * 纯函数：段落定位派生（与 Mini secondaryLabel 同公式，显式结构化）。
 * X = nextParagraphIndex + 1，钳制 1..total。
 */
export const deriveExpandedParagraph = (
    nextParagraphIndex: number,
    totalParagraphs: number
): ExpandedParagraphViewModel => {
    const total =
        Number.isFinite(totalParagraphs) && totalParagraphs > 0
            ? Math.floor(totalParagraphs)
            : 1;
    const rawNext = Number.isFinite(nextParagraphIndex) ? Math.floor(nextParagraphIndex) : 0;
    const current = Math.min(Math.max(rawNext + 1, 1), total);
    return { current, total };
};

/**
 * 纯函数：标题派生（与 Mini 同公式：trim 后空回退）。
 */
export const deriveExpandedTitle = (title: string): string => {
    const raw = typeof title === 'string' ? title.trim() : '';
    return raw.length > 0 ? title : EXPANDED_NOW_PLAYING_FALLBACK_TITLE;
};

/**
 * M7-02 纯函数：P3A timeline 派生（恒 segment，消毒 currentTime/duration）。
 * duration 非有限/<=0 → 0（fail-safe）；currentTime 钳制 [0, duration]。
 */
export const deriveExpandedTimeline = (
    currentTime: number,
    duration: number
): ExpandedTimelineViewModel => {
    const safeDuration =
        typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : 0;
    const rawCurrent =
        typeof currentTime === 'number' && Number.isFinite(currentTime) ? currentTime : 0;
    return {
        mode: EXPANDED_TIMELINE_MODE,
        currentTime: Math.min(Math.max(rawCurrent, 0), safeDuration),
        duration: safeDuration,
    };
};

/**
 * M7-02 纯函数：当前 Session 倍速派生（spec §20.1）。
 * Session.speed 优先（0.25–4.0 有限值）；非法时回退 Transport.playbackRate；
 * 再非法回退 1.0。不读 UserConfig（Expanded 仅当前 Session）。
 */
export const deriveExpandedPlaybackRate = (sessionSpeed: unknown, transportRate: unknown): number => {
    if (typeof sessionSpeed === 'number' && Number.isFinite(sessionSpeed) && sessionSpeed >= 0.25 && sessionSpeed <= 4.0) {
        return sessionSpeed;
    }
    if (typeof transportRate === 'number' && Number.isFinite(transportRate) && transportRate >= 0.25 && transportRate <= 4.0) {
        return transportRate;
    }
    return 1.0;
};

/**
 * M7-02 纯函数：是否可从头播放（有可展示 session 即 true，spec §38）。
 */
export const deriveExpandedCanRestart = (
    source: PlaybackSourceRef | null,
    status: PlaybackSessionStatus
): boolean => source !== null && status !== 'idle';

/**
 * M7-03 纯函数：SleepTimer ViewModel 派生（spec §22/§32）。
 * mode 非法 → off（fail-closed）；remaining 非正/非法 → null（off/story_end 恒 null）。
 */
export const deriveExpandedSleepTimer = (
    sleepTimerMode: unknown,
    remainingMs: unknown,
    source: PlaybackSourceRef | null
): ExpandedSleepTimerViewModel => {
    const mode: SleepTimerMode = isValidSleepTimerMode(sleepTimerMode) ? sleepTimerMode : 'off';
    const remaining =
        mode === 'minutes' &&
        typeof remainingMs === 'number' &&
        Number.isFinite(remainingMs) &&
        remainingMs > 0
            ? remainingMs
            : null;
    return { mode, remainingMs: remaining, isWork: source?.kind === 'work' };
};

/**
 * M7-04-01 纯函数：查看正文 Library 目标派生（spec §34）。
 * 唯一合法派生点：source.workId 直接消费（`resolveWorkLibraryTarget` 经
 * isValidWorkId 校验）；Draft/空/非法一律 null。
 */
export const deriveWorkLibraryTarget = (
    source: PlaybackSourceRef | null
): string | null => resolveWorkLibraryTarget(source);

/**
 * M7-04-01 纯函数：是否展示查看正文（spec §34）。
 * 有可展示会话（source 非空且 status 非 idle）且目标合法即 true。
 */
export const deriveExpandedCanViewStory = (
    source: PlaybackSourceRef | null,
    status: PlaybackSessionStatus
): boolean => {
    if (source === null || status === 'idle') {
        return false;
    }
    return resolveWorkLibraryTarget(source) !== null;
};

/**
 * M7-04-02 纯函数：Draft 只读正文派生（spec §35）。
 * 唯一来源 Session.storyText；Work/空/idle/无正文一律 null（fail-closed）。
 */
export const deriveDraftTranscriptText = (
    source: PlaybackSourceRef | null,
    storyText: unknown,
    status: PlaybackSessionStatus
): string | null => resolveDraftTranscriptText(source, storyText, status);

/**
 * M7-04-02 纯函数：Transcript 展示文本派生（§35.1 promotion 容忍）。
 * 有可展示会话且正文可用即返回原文（不分 Draft/Work），供已打开的
 * transcript 在 promotion 后继续展示；入口可见性仍由 Draft-only 判定把关。
 */
export const deriveTranscriptDisplayText = (
    source: PlaybackSourceRef | null,
    storyText: unknown,
    status: PlaybackSessionStatus
): string | null => resolveTranscriptDisplayText(source, storyText, status);

/**
 * M7-04-02 纯函数：是否展示 Draft 查看正文入口（spec §35）。
 * 有可展示 Draft 会话且正文可用即 true。
 */
export const deriveExpandedCanViewTranscript = (
    source: PlaybackSourceRef | null,
    storyText: unknown,
    status: PlaybackSessionStatus
): boolean => resolveDraftTranscriptText(source, storyText, status) !== null;

/**
 * 纯函数：ViewModel 总装（不复制 Store，只做展示派生）。
 */
export const deriveExpandedNowPlayingViewModel = (
    session: ExpandedSessionSnapshot,
    transport: ExpandedTransportSnapshot,
    voiceOptions: ReadonlyArray<Pick<VoiceOption, 'value' | 'label'>>
): ExpandedNowPlayingViewModel => {
    const hasSession = session.source !== null && session.status !== 'idle';
    // Transport.playbackRate 需经调用方传入？纯函数层不读 store：此处以 session.speed 为主，
    // transport 侧 rate 由 Hook 层透传（见下方 Hook 扩展，纯函数保持三参兼容）。
    const transportRate =
        (transport as unknown as { playbackRate?: unknown }).playbackRate ?? 1.0;
    const playbackRate = deriveExpandedPlaybackRate(session.speed ?? 1.0, transportRate);
    return {
        hasSession,
        sessionId: session.sessionId ?? null,
        title: deriveExpandedTitle(session.title),
        voiceLabel: deriveExpandedVoiceLabel(session.voiceId, voiceOptions),
        sessionStatus: session.status,
        source: session.source,
        paragraph: deriveExpandedParagraph(session.nextParagraphIndex, session.totalParagraphs),
        transport: {
            isPlaying: transport.isPlaying,
            currentTime: transport.currentTime,
            duration: transport.duration,
        },
        isEnded: session.status === 'ended',
        timeline: deriveExpandedTimeline(transport.currentTime, transport.duration),
        playbackRate,
        primaryAction: deriveExpandedPlaybackAction(session.status),
        canRestart: deriveExpandedCanRestart(session.source, session.status),
        isPlaying: transport.isPlaying,
        sleepTimer: deriveExpandedSleepTimer(
            session.sleepTimerMode ?? 'off',
            transport.remainingMs ?? null,
            session.source
        ),
        canViewStory: deriveExpandedCanViewStory(session.source, session.status),
        viewStoryTarget: deriveWorkLibraryTarget(session.source),
        canViewTranscript: deriveExpandedCanViewTranscript(
            session.source,
            session.storyText ?? '',
            session.status
        ),
        transcriptText: deriveTranscriptDisplayText(
            session.source,
            session.storyText ?? '',
            session.status
        ),
    };
};

/**
 * Hook：订阅 M5 Session + Transport + Config voiceOptions，派生 ViewModel。
 * 只读订阅，不 mutation 任何 store（M5 ownership 边界）。
 */
export const useExpandedNowPlayingViewModel = (): ExpandedNowPlayingViewModel => {
    const source = usePlaybackSessionStore((state) => state.source);
    const status = usePlaybackSessionStore((state) => state.status);
    const title = usePlaybackSessionStore((state) => state.title);
    const voiceId = usePlaybackSessionStore((state) => state.voiceId);
    const nextParagraphIndex = usePlaybackSessionStore((state) => state.nextParagraphIndex);
    const totalParagraphs = usePlaybackSessionStore((state) => state.totalParagraphs);
    const speed = usePlaybackSessionStore((state) => state.speed);
    const sleepTimerMode = usePlaybackSessionStore((state) => state.sleepTimerMode);
    const storyText = usePlaybackSessionStore((state) => state.storyText);
    const sessionId = usePlaybackSessionStore((state) => state.sessionId);
    const isPlaying = usePlaybackStore((state) => state.isPlaying);
    const currentTime = usePlaybackStore((state) => state.currentTime);
    const duration = usePlaybackStore((state) => state.duration);
    const playbackRate = usePlaybackStore((state) => state.playbackRate);
    const remainingMs = usePlaybackStore((state) => state.remainingMs);
    const voiceOptions = useConfigStore((state) => state.voiceOptions);

    return deriveExpandedNowPlayingViewModel(
        { source, status, title, voiceId, nextParagraphIndex, totalParagraphs, speed, sleepTimerMode, storyText, sessionId },
        { isPlaying, currentTime, duration, playbackRate, remainingMs } as unknown as ExpandedTransportSnapshot,
        voiceOptions
    );
};
