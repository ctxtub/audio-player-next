'use client';

/**
 *  PlaybackTimeline：展示当前 Transport 时间轴。
 *
 * - 数据仅取 Transport currentTime/duration，不复制播放状态。
 * - 正式 Work 对应完整音频并显示“播放进度”；旧 Draft 由调用方显示“本段”。
 * - 段落 identity 不进入本组件，兼容定位由 ParagraphStatus 展示。
 * - 点击 seek（§17.1）：pointer / trackWidth * duration → onSeek；
 * - 键盘（§17.2）：ArrowLeft/Down -5s、ArrowRight/Up +5s、Home 段首、End 段尾；
 * - 全 clamp + duration=0/unknown fail-safe（§17.3），ARIA slider 完整。
 *
 * 纯展示 + 回调：不读任何 store，不直调 flow/audio，clamp 主责在 Flow/Transport，
 * 本组件仅做指针换算与键盘映射（Flow 侧二次 clamp 兜底）。
 */

import React, { useCallback, useRef, useState } from 'react';
import { formatPlaybackTime } from '@/lib/playback/formatTime';

/**  timeline 固定模式（ 前恒 segment，不伪装整篇）。 */
export const EXPANDED_TIMELINE_MODE = 'segment' as const;

/** 键盘步进（秒，spec §17.2 ±5s）。 */
export const EXPANDED_TIMELINE_KEYBOARD_STEP_SECONDS = 5;

/** Timeline ARIA 标签（明确本段，与整篇 timeline 区分）。 */
export const EXPANDED_TIMELINE_ARIA_LABEL = '本段播放进度';

/**
 * 纯函数：分段时间格式化 M:SS（非有限/负数回退 0:00）。
 */
export const formatSegmentTime = formatPlaybackTime;

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
    /** 可见及辅助技术标签；旧草稿默认保留本段语义。 */
    label?: string;
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
    label = '本段',
    currentTime,
    duration,
    onSeek,
    disabled = false,
}) => {
    const safeDuration = typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : 0;
    const rawCurrent = typeof currentTime === 'number' && Number.isFinite(currentTime)
        ? Math.max(currentTime, 0)
        : 0;
    const safeCurrent = safeDuration > 0 ? Math.min(rawCurrent, safeDuration) : rawCurrent;
    const hasAudio = safeDuration > 0 && !disabled;

    const [isScrubbing, setIsScrubbing] = useState(false);
    const [scrubTime, setScrubTime] = useState<number | null>(null);
    const trackRef = useRef<HTMLDivElement | null>(null);

    const displayCurrent = isScrubbing && scrubTime !== null ? scrubTime : safeCurrent;
    const progressPercent = safeDuration > 0 ? (displayCurrent / safeDuration) * 100 : 0;

    const calculateTarget = useCallback(
        (clientX: number): number | null => {
            if (!trackRef.current || safeDuration <= 0) return null;
            const rect = trackRef.current.getBoundingClientRect();
            if (rect.width <= 0) return null;
            const percent = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
            return percent * safeDuration;
        },
        [safeDuration]
    );

    const handleClick = useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            if (!hasAudio || isScrubbing) {
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
        [hasAudio, isScrubbing, onSeek, safeDuration]
    );

    const handlePointerDown = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            if (!hasAudio) return;
            try {
                event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
                // Ignore capture failure in test/unsupported environments
            }
            setIsScrubbing(true);
            const target = calculateTarget(event.clientX);
            if (target !== null) {
                setScrubTime(target);
            }
        },
        [hasAudio, calculateTarget]
    );

    const handlePointerMove = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            if (!isScrubbing || !hasAudio) return;
            const target = calculateTarget(event.clientX);
            if (target !== null) {
                setScrubTime(target);
            }
        },
        [isScrubbing, hasAudio, calculateTarget]
    );

    const handlePointerUp = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            if (!isScrubbing) return;
            try {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                }
            } catch {
                // Ignore
            }
            setIsScrubbing(false);
            const target = calculateTarget(event.clientX);
            const finalTarget = target ?? scrubTime;
            setScrubTime(null);
            if (finalTarget !== null) {
                onSeek(finalTarget);
            }
        },
        [isScrubbing, calculateTarget, scrubTime, onSeek]
    );

    const handlePointerCancel = useCallback(() => {
        setIsScrubbing(false);
        setScrubTime(null);
    }, []);

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
            <div data-testid="expanded-timeline-label">{label}</div>
            <div
                ref={trackRef}
                data-testid="expanded-timeline-track"
                data-dragging={isScrubbing ? 'true' : 'false'}
                onClick={handleClick}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
                onKeyDown={handleKeyDown}
                role="slider"
                aria-label={label === '本段' ? EXPANDED_TIMELINE_ARIA_LABEL : label}
                aria-valuemin={0}
                aria-valuemax={Math.floor(safeDuration)}
                aria-valuenow={safeDuration > 0 ? Math.floor(displayCurrent) : 0}
                aria-valuetext={`${formatSegmentTime(displayCurrent)} / ${safeDuration > 0 ? formatSegmentTime(safeDuration) : '未知时长'}`}
                aria-disabled={!hasAudio}
                tabIndex={hasAudio ? 0 : -1}
            >
                <div
                    data-testid="expanded-timeline-fill"
                    style={{ width: `${progressPercent}%` }}
                />
                <div
                    data-testid="expanded-timeline-thumb"
                    style={{ left: `${progressPercent}%` }}
                />
            </div>
            <div data-testid="expanded-timeline-times">
                <span data-testid="expanded-timeline-current">{formatSegmentTime(displayCurrent)}</span>
                <span data-testid="expanded-timeline-duration">{safeDuration > 0 ? formatSegmentTime(safeDuration) : '—:——'}</span>
            </div>
        </div>
    );
};

export default PlaybackTimeline;
