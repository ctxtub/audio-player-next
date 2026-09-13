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
 * 纯派生见 deriveExpandedNowPlayingViewModel（可独立测试）；
 * Hook 层只做 selector 派生，不 mutation Session/Transport/Config。
 */

import { useConfigStore } from '@/stores/configStore';
import { usePlaybackSessionStore, type PlaybackSessionStatus } from '@/stores/playbackSessionStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import type { PlaybackSourceRef } from '@/lib/playback/source';
import type { VoiceOption } from '@/types/ttsGenerate';
import { MINI_NOW_PLAYING_FALLBACK_TITLE } from './types';

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

/** M7-01 Expanded ViewModel（Header/Surface 最小集）。 */
export type ExpandedNowPlayingViewModel = {
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
};

/** Session 快照输入（纯函数层，不依赖 store）。 */
export type ExpandedSessionSnapshot = {
    source: PlaybackSourceRef | null;
    status: PlaybackSessionStatus;
    title: string;
    voiceId: string;
    nextParagraphIndex: number;
    totalParagraphs: number;
};

/** Transport 快照输入（纯函数层）。 */
export type ExpandedTransportSnapshot = {
    isPlaying: boolean;
    currentTime: number;
    duration: number;
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
 * 纯函数：ViewModel 总装（不复制 Store，只做展示派生）。
 */
export const deriveExpandedNowPlayingViewModel = (
    session: ExpandedSessionSnapshot,
    transport: ExpandedTransportSnapshot,
    voiceOptions: ReadonlyArray<Pick<VoiceOption, 'value' | 'label'>>
): ExpandedNowPlayingViewModel => {
    const hasSession = session.source !== null && session.status !== 'idle';
    return {
        hasSession,
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
    const isPlaying = usePlaybackStore((state) => state.isPlaying);
    const currentTime = usePlaybackStore((state) => state.currentTime);
    const duration = usePlaybackStore((state) => state.duration);
    const voiceOptions = useConfigStore((state) => state.voiceOptions);

    return deriveExpandedNowPlayingViewModel(
        { source, status, title, voiceId, nextParagraphIndex, totalParagraphs },
        { isPlaying, currentTime, duration },
        voiceOptions
    );
};
