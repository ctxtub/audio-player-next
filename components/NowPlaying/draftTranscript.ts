/**
 * M7-04-02 Draft Transcript 纯 helper（spec §35 / §35.1 / §72）。
 *
 * - 数据唯一来源：M5 Session.storyText（本文件不读任何 store，只收参判定）；
 * - Draft「查看正文」绝不生成 /library/[fake-id]（Draft 无 StoryWork.id，
 *   本文件不拼凑任何 Library 目标；Work 导航仍归 workViewStoryNavigation）；
 * - controls ↔ transcript 切换是 Expanded 内部局部 view state（调用方
 *   useState 持有），不进入 global UI Store（本文件不触 nowPlayingUiStore）；
 * - fail-closed：无 storyText / 空白 / 非 Draft / 空 source / idle 一律
 *   返回 null / false（不展示或空态，不拼假 target）。
 */

import type { PlaybackSourceRef } from '@/lib/playback/source';
import type { PlaybackSessionStatus } from '@/stores/playbackSessionStore';

/** Draft Transcript 只读容器 testid（Expanded 内部局部视图）。 */
export const EXPANDED_TRANSCRIPT_TESTID = 'expanded-transcript';

/** Transcript 正文文本 testid（只读展示，唯一数据源 Session.storyText）。 */
export const EXPANDED_TRANSCRIPT_TEXT_TESTID = 'expanded-transcript-text';

/** Transcript 空态 testid（无 storyText 时 fail-closed 空态，不拼假文）。 */
export const EXPANDED_TRANSCRIPT_EMPTY_TESTID = 'expanded-transcript-empty';

/** Draft 查看正文（开 Transcript）按钮 testid（与 Work 导航按钮区分行为）。 */
export const EXPANDED_VIEW_TRANSCRIPT_BUTTON_TESTID = 'expanded-view-transcript-button';

/** Transcript 返回控制按钮 testid（只切局部 view，不改 Session）。 */
export const EXPANDED_TRANSCRIPT_BACK_BUTTON_TESTID = 'expanded-transcript-back-button';

/** Transcript 内「打开作品详情」按钮 testid（§35.1 promotion 后入口）。 */
export const EXPANDED_OPEN_WORK_DETAIL_BUTTON_TESTID = 'expanded-open-work-detail-button';

/** Transcript 返回控制文案（§72：返回控制不改变 Session）。 */
export const TRANSCRIPT_BACK_LABEL = '返回控制';

/** Transcript promotion 后入口文案（§35.1：之后再点击即可进入 /library/[workId]）。 */
export const OPEN_WORK_DETAIL_LABEL = '打开作品详情';

/** Transcript 空态文案（fail-closed：无 storyText 时展示，不伪造正文）。 */
export const TRANSCRIPT_EMPTY_LABEL = '暂无正文';

/**
 * 纯函数：正文归一（去首尾空白；空/空白/非字符串一律 null）。
 * 不截断、不拼接、不猜测（原文原样透传由调用方渲染）。
 */
export const normalizeDraftTranscriptText = (storyText: unknown): string | null => {
    if (typeof storyText !== 'string') {
        return null;
    }
    const trimmed = storyText.trim();
    if (trimmed.length === 0) {
        return null;
    }
    return storyText;
};

/**
 * 纯函数：Draft Transcript 文本派生（fail-closed）。
 * 仅当 source 为合法 Draft 且 status 非 idle 且 storyText 非空才返回原文；
 * Work / 空 source / idle / 无正文一律 null（绝不拼凑）。
 */
export const resolveDraftTranscriptText = (
    source: PlaybackSourceRef | null | undefined,
    storyText: unknown,
    status: PlaybackSessionStatus | null | undefined
): string | null => {
    if (source === null || source === undefined) {
        return null;
    }
    if (source.kind !== 'draft') {
        return null;
    }
    if (status === null || status === undefined || status === 'idle') {
        return null;
    }
    return normalizeDraftTranscriptText(storyText);
};

/**
 * 纯函数：是否应展示 Draft 查看正文入口（Actions 内）。
 * 有可展示 Draft 会话且正文可用即 true；其余一律 false。
 */
export const shouldShowDraftTranscript = (
    source: PlaybackSourceRef | null | undefined,
    storyText: unknown,
    status: PlaybackSessionStatus | null | undefined
): boolean => resolveDraftTranscriptText(source, storyText, status) !== null;

/**
 * 纯函数：Transcript 展示文本派生（§35.1 promotion 容忍）。
 * 有可展示会话（source 非空且 status 非 idle）且 storyText 非空即返回原文，
 * 不分 Draft/Work——已打开的 transcript 在 promotion（source 切 work，
 * sessionId 不变）后仍继续展示 Session.storyText；入口可见性仍由
 * shouldShowDraftTranscript（Draft-only）单独把关。
 */
export const resolveTranscriptDisplayText = (
    source: PlaybackSourceRef | null | undefined,
    storyText: unknown,
    status: PlaybackSessionStatus | null | undefined
): string | null => {
    if (source === null || source === undefined) {
        return null;
    }
    if (status === null || status === undefined || status === 'idle') {
        return null;
    }
    return normalizeDraftTranscriptText(storyText);
};

/** Draft Transcript 展示决策输入。 */
export type DraftTranscriptDecisionInput = {
    source: PlaybackSourceRef | null | undefined;
    storyText: unknown;
    status: PlaybackSessionStatus | null | undefined;
};

/** Draft Transcript 展示决策（纯展示决策，不执行副作用）。 */
export type DraftTranscriptDecision = {
    /** 是否展示查看正文入口。 */
    visible: boolean;
    /** 只读正文（可见时为原文；隐藏时 null）。 */
    text: string | null;
};

/**
 * 纯函数：Draft Transcript 总决策（调用方：可见时渲染入口，
 * 点击后切 Expanded 局部 view → TranscriptView，不导航）。
 */
export const decideDraftTranscript = (
    input: DraftTranscriptDecisionInput
): DraftTranscriptDecision => {
    const text = resolveDraftTranscriptText(input.source, input.storyText, input.status);
    if (text === null) {
        return { visible: false, text: null };
    }
    return { visible: true, text };
};
