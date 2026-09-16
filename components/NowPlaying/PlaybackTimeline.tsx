'use client';

/**
 *  PlaybackTimeline（spec §17  当前 Segment timeline）。
 *
 *  严格为当前 Segment（不是整篇 duration）：
 * - timeline.mode 恒为 'segment'（ 前不展示假整篇 duration，spec §68）；
 * - 数据仅取  Transport currentTime/duration（段内位置），段落 identity
 *（nextParagraphIndex）绝不进入本组件；
 * - UI 必须明确“本段”，如「本段 01:24 / 02:16」+「第 4 / 12 段」（后者由
 *   ParagraphStatus 负责，本组件只渲染时间轴本体 + 本段标签）。
 * - 点击 seek（§17.1）：pointer / trackWidth * duration → onSeek；
 * - 键盘（§17.2）：ArrowLeft/Down -5s、ArrowRight/Up +5s、Home 段首、End 段尾；
 * - 全 clamp + duration=0/unknown fail-safe（§17.3），ARIA slider 完整。
 *
 * 纯展示 + 回调：不读任何 store，不直调 flow/audio，clamp 主责在 Flow/Transport，
 * 本组件仅做指针换算与键盘映射（Flow 侧二次 clamp 兜底）。
 */

import React, { useCallback } from 'react';

/**  timeline 固定模式（ 前恒 segment，不伪装整篇）。 */
export const EXPANDED_TIMELINE_MODE = 'segment' as const;

/** 键盘步进（秒，spec §17.2 ±5s）。 */
export const EXPANDED_TIMELINE_KEYBOARD_STEP_SECONDS = 5;

/** Timeline ARIA 标签（明确本段，与整篇 timeline 区分）。 */
export const EXPANDED_TIMELINE_ARIA_LABEL = '本段播放进度';

/**
 * 纯函数：分段时间格式化 M:SS（非有限/负数回退 0:00）。
 */
export const formatSegmentTime = (seconds: number): string => {
    const safe = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const minutes = Math.floor(safe / 60);
    const secs = Math.floor(safe % 60);
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
};

/**
 * 纯函数：点击换算（pointerX/trackWidth * duration）。
 * 非法输入（trackWidth<=0/duration<=0/非有限）返回 null（调用方 no-op，fail-safe）。
 */
export const resolveClickSeekTarget = (input: {
    clientX: number;
    trackLeft: number;
    trackWidth: number;
    duration: number;
}): number | null => {
    const { clientX, trackLeft, trackWidth, duration } = input;
    if (
        !Number.isFinite(clientX) ||
        !Number.isFinite(trackLeft) ||
        !Number.isFinite(trackWidth) ||
        !Number.isFinite(duration)
    ) {
        return null;
    }
    if (!(trackWidth > 0) || !(duration > 0)) {
        return null;
    }
    const percent = (clientX - trackLeft) / trackWidth;
    const clampedPercent = Math.min(1, Math.max(0, percent));
    return clampedPercent * duration;
};

/**
 * 纯函数：键盘映射（spec §17.2）。
 * 返回目标秒数；未知键返回 null（调用方忽略）；hasAudio=false 时调用方直接 no-op。
 */
export const resolveKeyboardSeekTarget = (input: {
    key: string;
    currentTime: number;
    duration: number;
}): number | null => {
    const { key, currentTime, duration } = input;
    const step = EXPANDED_TIMELINE_KEYBOARD_STEP_SECONDS;
    switch (key) {
        case 'ArrowLeft':
        case 'ArrowDown':
            return currentTime - step;
        case 'ArrowRight':
        case 'ArrowUp':
            return currentTime + step;
        case 'Home':
            return 0;
        case 'End':
            return duration;
        default:
            return null;
    }
};

/** PlaybackTimeline props（全部受控，父级经 ViewModel + facade 传入）。 */
export type PlaybackTimelineProps = {
    /** 段内当前时间（秒，Transport）。 */
    currentTime: number;
    /** 段内总时长（秒，Transport；0 表示未知）。 */
    duration: number;
    /** seek 回调（父级经 useExpandedPlaybackControls.seekCurrentSegment 传入）。 */
    onSeek: (targetSeconds: number) => void;
    /** 是否禁用（无 session 时 true）。 */
    disabled?: boolean;
};

export const PlaybackTimeline: React.FC<PlaybackTimelineProps> = ({
    currentTime,
    duration,
    onSeek,
    disabled = false,
}) => {
    const safeDuration = typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : 0;
    const safeCurrent =
        typeof currentTime === 'number' && Number.isFinite(currentTime)
            ? Math.min(Math.max(currentTime, 0), safeDuration)
            : 0;
    const hasAudio = safeDuration > 0 && !disabled;
    const progressPercent = safeDuration > 0 ? (safeCurrent / safeDuration) * 100 : 0;

    const handleClick = useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            if (!hasAudio) {
                return;
            }
            const track = event.currentTarget;
            const rect = track.getBoundingClientRect();
            const target = resolveClickSeekTarget({
                clientX: event.clientX,
                trackLeft: rect.left,
                trackWidth: rect.width,
                duration: safeDuration,
            });
            if (target === null) {
                return;
            }
            onSeek(target);
        },
        [hasAudio, onSeek, safeDuration]
    );

    const handleKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (!hasAudio) {
                return;
            }
            const next = resolveKeyboardSeekTarget({
                key: event.key,
                currentTime: safeCurrent,
                duration: safeDuration,
            });
            if (next === null) {
                return;
            }
            event.preventDefault();
            onSeek(next);
        },
        [hasAudio, onSeek, safeCurrent, safeDuration]
    );

    return (
        <div data-testid="expanded-timeline" data-mode={EXPANDED_TIMELINE_MODE}>
            <div data-testid="expanded-timeline-label">本段</div>
            <div
                data-testid="expanded-timeline-track"
                onClick={handleClick}
                onKeyDown={handleKeyDown}
                role="slider"
                aria-label={EXPANDED_TIMELINE_ARIA_LABEL}
                aria-valuemin={0}
                aria-valuemax={Math.floor(safeDuration)}
                aria-valuenow={Math.floor(safeCurrent)}
                aria-valuetext={`${formatSegmentTime(safeCurrent)} / ${formatSegmentTime(safeDuration)}`}
                aria-disabled={!hasAudio}
                tabIndex={hasAudio ? 0 : -1}
            >
                <div
                    data-testid="expanded-timeline-fill"
                    style={{ width: `${progressPercent}%` }}
                />
            </div>
            <div data-testid="expanded-timeline-times">
                <span data-testid="expanded-timeline-current">{formatSegmentTime(safeCurrent)}</span>
                <span data-testid="expanded-timeline-duration">{formatSegmentTime(safeDuration)}</span>
            </div>
        </div>
    );
};

export default PlaybackTimeline;
