'use client';

/**
 * M7-04-01 NowPlayingActions（spec §33-§34 Expanded 内容动作区）。
 * + M7-04-02 Draft Transcript 入口（spec §35 additive，不破 Work 面）。
 *
 * - 受控展示组件：只收 props，不读任何 store，不直调路由与播放写面；
 * - Work source（含合法目标）即展示「查看正文」（导航口，复用
 *   VIEW_STORY_LABEL；点击经父级 onViewStory 统一处理：先 closeExpanded
 *   再按需 push，播放继续）；本组件仅透传回调；
 * - Draft source（含可用 storyText）即展示「查看正文」（Transcript 口，
 *   同文案、独立 testid；点击经父级 onViewTranscript 切 Expanded 局部
 *   view → TranscriptView，不导航、不拼凑 /library/[fake-id]）；
 * - Work 优先（promotion 后 source 切 work 即走导航口）；两者皆无时
 *   返回 null（不占位）；
 * - 本区仅承载播放伴随的内容导航/正文，Story 内容管理仍归 Detail 面。
 */

import React from 'react';
import { BookOpen } from 'lucide-react';
import type { PlaybackSourceRef } from '@/lib/playback/source';
import type { PlaybackSessionStatus } from '@/stores/playbackSessionStore';
import {
    EXPANDED_ACTIONS_TESTID,
    EXPANDED_VIEW_STORY_BUTTON_TESTID,
    VIEW_STORY_LABEL,
    shouldShowWorkViewStory,
} from './workViewStoryNavigation';
import {
    EXPANDED_VIEW_TRANSCRIPT_BUTTON_TESTID,
    shouldShowDraftTranscript,
} from './draftTranscript';

/** NowPlayingActions props（全部受控，父级经 ViewModel + 回调传入）。 */
export type NowPlayingActionsProps = {
    /** 当前播放来源（Work 口的唯一依据）。 */
    source: PlaybackSourceRef | null;
    /** 无可展示会话时禁用按钮（展示与可用性分离）。 */
    disabled?: boolean;
    /** 查看正文回调（Work 口，父级：closeExpanded 先行，按需 push，播放继续）。 */
    onViewStory: () => void;
    /**
     * M7-04-02 Draft 正文（M5 Session.storyText 原文；缺省空即 Draft 口隐藏，
     * 保持 M7-04-01 调用兼容）。
     */
    storyText?: string | null;
    /**
     * M7-04-02 Draft 会话状态（缺省 paused，保持旧调用兼容；idle 即隐藏）。
     * 显式传入时与 ViewModel.canViewTranscript 同口径（fail-closed）。
     */
    status?: PlaybackSessionStatus;
    /**
     * M7-04-02 查看正文回调（Draft 口，父级：只切 Expanded 局部 view →
     * TranscriptView，不导航、不改 Session）。
     */
    onViewTranscript?: () => void;
};

export const NowPlayingActions: React.FC<NowPlayingActionsProps> = ({
    source,
    disabled = false,
    onViewStory,
    storyText = null,
    status = 'paused',
    onViewTranscript,
}) => {
    // M7-04-01 Work 口冻结（行为不变：合法 Work 目标即展示，导航口）。
    if (shouldShowWorkViewStory(source)) {
        return (
            <div data-testid={EXPANDED_ACTIONS_TESTID}>
                <button
                    type="button"
                    data-testid={EXPANDED_VIEW_STORY_BUTTON_TESTID}
                    onClick={onViewStory}
                    disabled={disabled}
                    aria-label={VIEW_STORY_LABEL}
                    title={VIEW_STORY_LABEL}
                >
                    <BookOpen size={18} aria-hidden="true" />
                    <span>{VIEW_STORY_LABEL}</span>
                </button>
            </div>
        );
    }
    // M7-04-02 Draft 口（additive：Draft + 可用 storyText 才展示；
    // 同文案、独立 testid；无回调时隐藏，不占位）。
    if (
        typeof onViewTranscript === 'function' &&
        shouldShowDraftTranscript(source, storyText, status)
    ) {
        return (
            <div data-testid={EXPANDED_ACTIONS_TESTID}>
                <button
                    type="button"
                    data-testid={EXPANDED_VIEW_TRANSCRIPT_BUTTON_TESTID}
                    onClick={onViewTranscript}
                    disabled={disabled}
                    aria-label={VIEW_STORY_LABEL}
                    title={VIEW_STORY_LABEL}
                >
                    <BookOpen size={18} aria-hidden="true" />
                    <span>{VIEW_STORY_LABEL}</span>
                </button>
            </div>
        );
    }
    return null;
};

export default NowPlayingActions;
