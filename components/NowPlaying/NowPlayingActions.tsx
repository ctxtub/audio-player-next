'use client';

/**
 * M7-04-01 NowPlayingActions（spec §33-§34 Expanded 内容动作区）。
 * + M7-04-02 Draft Transcript 入口（spec §35 additive，不破 Work 面）。
 * + M7-04-03 Creation Actions Boundary（spec §36/§37 additive，不破既有口）。
 *
 * - 受控展示组件：只收 props，不读任何 store，不直调路由与播放写面；
 * - Work source（含合法目标）即展示「查看正文」（导航口，复用
 *   VIEW_STORY_LABEL；点击经父级 onViewStory 统一处理：先 closeExpanded
 *   再按需 push，播放继续）；本组件仅透传回调；
 * - Draft source（含可用 storyText）即展示「查看正文」（Transcript 口，
 *   同文案、独立 testid；点击经父级 onViewTranscript 切 Expanded 局部
 *   view → TranscriptView，不导航、不拼凑 /library/[fake-id]）；
 * - Draft source（含可展示会话，与 storyText 无关）即展示「返回创作」
 *   （spec §37，独立 testid；点击经父级 onBackToCreation 统一处理：
 *   先 closeExpanded 再 push('/chat')，绝不自动发送新 Prompt）；
 *   与「查看正文」同容器并存（两者皆可见时双按钮，各自独立回调）；
 * - Work「继续创作」（spec §36.2/M7-P07）：M4 `continueFromStoryWork`
 *   契约未落地前隐藏（fail-closed，绝不伪造 continuation）；分支结构
 *   additive-ready（onContinueCreation 预留 + shouldShowWorkContinueCreation
 *   判定），契约落地后直接开启，不需改播放架构；
 * - Work 优先（promotion 后 source 切 work 即走导航口）；两者皆无时
 *   返回 null（不占位）；
 * - 本区仅承载播放伴随的内容导航/正文/创作返回，Story 内容管理仍归 Detail 面。
 */

import React from 'react';
import { BookOpen, MessageCircle, PenLine } from 'lucide-react';
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
import {
    BACK_TO_CREATION_LABEL,
    CONTINUE_CREATION_LABEL,
    EXPANDED_BACK_TO_CREATION_BUTTON_TESTID,
    EXPANDED_CONTINUE_CREATION_BUTTON_TESTID,
    shouldShowDraftBackToCreation,
    shouldShowWorkContinueCreation,
} from './creationActions';

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
    /**
     * M7-04-03 返回创作回调（Draft 口，spec §37，父级：closeExpanded 先行
     * 再 push('/chat')，绝不自动发送新 Prompt；缺省/undefined 时该口隐藏）。
     */
    onBackToCreation?: () => void;
    /**
     * M7-04-03 继续创作回调（Work 口，spec §36.2/M7-P07 additive-ready 预留：
     * M4 `continueFromStoryWork` 契约落地后由父级委托该契约；本轮判定恒
     * 隐藏，缺省/undefined 时亦隐藏）。
     */
    onContinueCreation?: () => void;
};

export const NowPlayingActions: React.FC<NowPlayingActionsProps> = ({
    source,
    disabled = false,
    onViewStory,
    storyText = null,
    status = 'paused',
    onViewTranscript,
    onBackToCreation,
    onContinueCreation,
}) => {
    // M7-04-01 Work 口冻结（行为不变：合法 Work 目标即展示，导航口）。
    // M7-04-03 Work 继续创作 additive-ready：判定恒隐藏（M4 契约缺失，
    // fail-closed），分支保留供契约落地后直接开启（不改播放架构）。
    if (shouldShowWorkViewStory(source)) {
        const showContinueCreation =
            typeof onContinueCreation === 'function' &&
            shouldShowWorkContinueCreation(source, status);
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
                {showContinueCreation ? (
                    <button
                        type="button"
                        data-testid={EXPANDED_CONTINUE_CREATION_BUTTON_TESTID}
                        onClick={onContinueCreation}
                        disabled={disabled}
                        aria-label={CONTINUE_CREATION_LABEL}
                        title={CONTINUE_CREATION_LABEL}
                    >
                        <PenLine size={18} aria-hidden="true" />
                        <span>{CONTINUE_CREATION_LABEL}</span>
                    </button>
                ) : null}
            </div>
        );
    }
    // M7-04-02 Draft 口（additive：Draft + 可用 storyText 才展示；
    // 同文案、独立 testid；无回调时隐藏，不占位）。
    // M7-04-03 Draft 返回创作（spec §37 additive：Draft + 可展示会话即展示，
    // 与 storyText 无关；同容器与查看正文并存，各自独立回调）。
    const showTranscript =
        typeof onViewTranscript === 'function' &&
        shouldShowDraftTranscript(source, storyText, status);
    const showBackToCreation =
        typeof onBackToCreation === 'function' &&
        shouldShowDraftBackToCreation(source, status);
    if (!showTranscript && !showBackToCreation) {
        return null;
    }
    // Work 继续创作在 Draft 面永不出现（kind 互斥 + 判定恒隐藏双保险）。
    return (
        <div data-testid={EXPANDED_ACTIONS_TESTID}>
            {showTranscript ? (
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
            ) : null}
            {showBackToCreation ? (
                <button
                    type="button"
                    data-testid={EXPANDED_BACK_TO_CREATION_BUTTON_TESTID}
                    onClick={onBackToCreation}
                    disabled={disabled}
                    aria-label={BACK_TO_CREATION_LABEL}
                    title={BACK_TO_CREATION_LABEL}
                >
                    <MessageCircle size={18} aria-hidden="true" />
                    <span>{BACK_TO_CREATION_LABEL}</span>
                </button>
            ) : null}
        </div>
    );
};

export default NowPlayingActions;
