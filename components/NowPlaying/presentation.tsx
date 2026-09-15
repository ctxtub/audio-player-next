'use client';

/**
 * M6-02 MiniNowPlaying 共享 presentation primitives（spec §9/§58）。
 *
 * 纯展示原子：只收 props，不读任何 store / Session / Transport /
 * legacy playbackProgressStore / GenerationHistory / StoryCard。
 * DOM 约束：
 * - Metadata 与播放按钮为两个独立 interactive target（禁止 button 嵌套 button）；
 * - ProgressRail 非交互、非 seek，role=progressbar，aria-label 故事段落进度；
 * - 触控热区 >=44px（var(--size-touch-target)）；视觉图标保持紧凑。
 */

import React from 'react';
import { Loader2, Pause, Play, RotateCcw, RotateCw } from 'lucide-react';

import type { MiniPlaybackAction } from './types';

/** Metadata 按钮 props（点击 → openDetails/openExpanded，显式透传触发元素供焦点返回）。 */
export type MiniMetadataButtonProps = {
    title: string;
    secondaryLabel: string | null;
    coarseProgress: number | null;
    onOpenDetails: (target?: HTMLElement | null) => void;
};

/** 播放动作按钮 props（点击 → Flow delegation，不打开详情）。 */
export type MiniPlaybackButtonProps = {
    action: MiniPlaybackAction;
    statusLabel: string;
    onAction: () => void;
};

/** 进度 rail props（非交互粗进度）。 */
export type MiniProgressRailProps = {
    coarseProgress: number | null;
};

const actionMeta: Record<
    MiniPlaybackAction,
    { label: string; Icon: typeof Play }
> = {
    play: { label: '播放', Icon: Play },
    pause: { label: '暂停播放', Icon: Pause },
    restart: { label: '重新播放', Icon: RotateCcw },
    retry: { label: '重试播放', Icon: RotateCw },
    disabled: { label: '正在准备语音', Icon: Loader2 },
};

/**
 * 非交互粗进度 rail（spec §8.1/§58）。
 * 不展示百分比/精确时间；键盘不可聚焦；seek 归 M7。
 */
export const MiniProgressRail: React.FC<MiniProgressRailProps> = ({ coarseProgress }) => {
    if (coarseProgress === null) {
        return null;
    }
    const percent = Math.round(Math.min(1, Math.max(0, coarseProgress)) * 100);
    return (
        <div
            role="progressbar"
            aria-label="故事段落进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            data-testid="mini-progress-rail"
        >
            <div data-testid="mini-progress-fill" style={{ width: `${percent}%` }} />
        </div>
    );
};

/**
 * Metadata 按钮：Title + SecondaryLabel + ProgressRail。
 * aria-label 展开正在播放：{title}（spec §58）。
 */
export const MiniMetadataButton: React.FC<MiniMetadataButtonProps> = ({
    title,
    secondaryLabel,
    coarseProgress,
    onOpenDetails,
}) => (
    <button
        type="button"
        aria-label={`展开正在播放：${title}`}
        // WebKit 点击 <button> 不自动聚焦（activeElement 仍为 body）：
        // 显式透传 e.currentTarget，store 不再依赖 open 时的 activeElement 捕获。
        onClick={(e) => onOpenDetails(e.currentTarget as unknown as HTMLElement)}
        data-testid="mini-metadata-button"
    >
        <span data-testid="mini-title">{title}</span>
        {secondaryLabel !== null ? (
            <span data-testid="mini-secondary-label">{secondaryLabel}</span>
        ) : null}
        <MiniProgressRail coarseProgress={coarseProgress} />
    </button>
);

/**
 * 播放动作按钮：只负责 play/pause/restart/retry，不打开详情（spec §9.1）。
 * synthesizing/disabled 置 disabled；其余保持可点击。
 */
export const MiniPlaybackButton: React.FC<MiniPlaybackButtonProps> = ({
    action,
    statusLabel,
    onAction,
}) => {
    const meta = actionMeta[action];
    const { Icon } = meta;
    const disabled = action === 'disabled';
    return (
        <button
            type="button"
            aria-label={meta.label}
            title={statusLabel}
            disabled={disabled}
            onClick={onAction}
            data-testid="mini-playback-button"
        >
            <Icon size={18} strokeWidth={2} aria-hidden="true" />
        </button>
    );
};
