'use client';

/**
 * M7-04-01 NowPlayingActions（spec §33-§34 Expanded 内容动作区）。
 *
 * - 受控展示组件：只收 props，不读任何 store，不直调路由与播放写面；
 * - Work source（含合法目标）即展示「查看正文」，其余一律返回 null
 *   （Expanded 内部不拼凑 Library 目标；Draft 形态归后续子项）；
 * - 点击经父级 onViewStory 统一处理（先 closeExpanded 再按需 push，
 *   播放继续）；本组件仅透传回调；
 * - 本区仅承载播放伴随的内容导航，Story 内容管理仍归 Detail 面。
 */

import React from 'react';
import { BookOpen } from 'lucide-react';
import type { PlaybackSourceRef } from '@/lib/playback/source';
import {
    EXPANDED_ACTIONS_TESTID,
    EXPANDED_VIEW_STORY_BUTTON_TESTID,
    VIEW_STORY_LABEL,
    shouldShowWorkViewStory,
} from './workViewStoryNavigation';

/** NowPlayingActions props（全部受控，父级经 ViewModel + 回调传入）。 */
export type NowPlayingActionsProps = {
    /** 当前播放来源（是否展示查看正文的唯一依据）。 */
    source: PlaybackSourceRef | null;
    /** 无可展示会话时禁用按钮（展示与可用性分离）。 */
    disabled?: boolean;
    /** 查看正文回调（父级：closeExpanded 先行，按需 push，播放继续）。 */
    onViewStory: () => void;
};

export const NowPlayingActions: React.FC<NowPlayingActionsProps> = ({
    source,
    disabled = false,
    onViewStory,
}) => {
    if (!shouldShowWorkViewStory(source)) {
        return null;
    }
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
};

export default NowPlayingActions;
