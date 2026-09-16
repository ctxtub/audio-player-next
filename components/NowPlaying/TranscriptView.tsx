'use client';

/**
 *  TranscriptView（spec §35 只读正文面 / §72 验证）。
 *
 * - 只读展示：数据唯一来源为父级传入的  Session.storyText（经
 *   ViewModel.transcriptText 派生）；本组件不读任何 store，不直调
 *   Flow/路由/<audio>/Session 字段；
 * - 无编辑面：无 textarea/input/contentEditable（架构守卫锁定）；
 * - fail-closed：storyText 为 null/空时渲染空态（暂无正文），不伪造正文、
 *   不拼凑任何 Library 目标；
 * - §35.1 promotion：transcript 保持打开由父级局部 view state 保证；
 *   promotion 后父级传入 onOpenWorkDetail（复用 Work 先关后导 handler）
 *   时才展示「打开作品详情」入口，否则不展示（不越界进  流程）。
 */

import React from 'react';
import { ArrowLeft, BookOpen } from 'lucide-react';
import {
    EXPANDED_OPEN_WORK_DETAIL_BUTTON_TESTID,
    EXPANDED_TRANSCRIPT_BACK_BUTTON_TESTID,
    EXPANDED_TRANSCRIPT_EMPTY_TESTID,
    EXPANDED_TRANSCRIPT_TESTID,
    EXPANDED_TRANSCRIPT_TEXT_TESTID,
    OPEN_WORK_DETAIL_LABEL,
    TRANSCRIPT_BACK_LABEL,
    TRANSCRIPT_EMPTY_LABEL,
} from './draftTranscript';

/** TranscriptView props（全部受控，父级经 ViewModel + 回调传入）。 */
export type TranscriptViewProps = {
    /** 只读正文（ Session.storyText 原文；null/空 → 空态）。 */
    storyText: string | null;
    /** 返回控制回调（父级：只切局部 view → controls，不改 Session/Transport）。 */
    onBack: () => void;
    /**
     * 打开作品详情回调（§35.1：仅 promotion 后父级传入；
     * 缺省/undefined 时不展示该入口，不越界）。
     */
    onOpenWorkDetail?: (() => void) | null;
    /** 无可展示会话时禁用按钮（展示与可用性分离，与 Actions 同口径）。 */
    disabled?: boolean;
};

export const TranscriptView: React.FC<TranscriptViewProps> = ({
    storyText,
    onBack,
    onOpenWorkDetail = null,
    disabled = false,
}) => {
    const hasText = typeof storyText === 'string' && storyText.trim().length > 0;
    const showOpenDetail = typeof onOpenWorkDetail === 'function';
    return (
        <div data-testid={EXPANDED_TRANSCRIPT_TESTID}>
            {hasText ? (
                <div data-testid={EXPANDED_TRANSCRIPT_TEXT_TESTID}>
                    {storyText}
                </div>
            ) : (
                <div data-testid={EXPANDED_TRANSCRIPT_EMPTY_TESTID}>
                    {TRANSCRIPT_EMPTY_LABEL}
                </div>
            )}
            <div>
                <button
                    type="button"
                    data-testid={EXPANDED_TRANSCRIPT_BACK_BUTTON_TESTID}
                    onClick={onBack}
                    disabled={disabled}
                    aria-label={TRANSCRIPT_BACK_LABEL}
                    title={TRANSCRIPT_BACK_LABEL}
                >
                    <ArrowLeft size={18} aria-hidden="true" />
                    <span>{TRANSCRIPT_BACK_LABEL}</span>
                </button>
                {showOpenDetail ? (
                    <button
                        type="button"
                        data-testid={EXPANDED_OPEN_WORK_DETAIL_BUTTON_TESTID}
                        onClick={onOpenWorkDetail}
                        disabled={disabled}
                        aria-label={OPEN_WORK_DETAIL_LABEL}
                        title={OPEN_WORK_DETAIL_LABEL}
                    >
                        <BookOpen size={18} aria-hidden="true" />
                        <span>{OPEN_WORK_DETAIL_LABEL}</span>
                    </button>
                ) : null}
            </div>
        </div>
    );
};

export default TranscriptView;
