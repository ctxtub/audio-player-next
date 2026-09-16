'use client';

/**
 *  PlaybackControls（spec §16 Playback Controls Facade 消费端 + §41 Keyboard）。
 *
 * - Play / Pause / 从头播放全部走  ownership（父级经
 *   useExpandedPlaybackControls 传入回调，本组件不直调 flow/store/audio）；
 * - 段内 ±5s 为当前 Segment seek（Transport 段内位置），不是段落跳转；
 * - 明确不新增「上一段/下一段」段落跳转（spec §40 拒绝；本文件不得出现
 *   上一段/下一段文案与段落切换回调）；
 * - 整个 Modal 不增加 Space=Play/Pause、Left=Seek 全局监听（spec §41），
 *   仅 Slider 自身键盘语义（见 PlaybackTimeline）。
 *
 * 纯展示 + 回调：只收 props，不读任何 store。
 */

import React from 'react';
import { Pause, Play, RotateCcw, RotateCw, Rewind, FastForward } from 'lucide-react';

/**
 * Expanded 主动作（与 Mini primaryAction 同映射，保证 Mini/Expanded 同 Session
 * 下动作语义一致；synthesizing/hydrating → disabled）。
 */
export type ExpandedPlaybackAction = 'play' | 'pause' | 'restart' | 'retry' | 'disabled';

/**
 * 纯函数：Session status → Expanded 主动作（spec §14 ViewModel 派生）。
 * playing → pause；ready/paused → play；ended → restart；error → retry；
 * synthesizing/hydrating → disabled；idle → disabled。
 */
export const deriveExpandedPlaybackAction = (
    status: 'idle' | 'hydrating' | 'ready' | 'synthesizing' | 'playing' | 'paused' | 'ended' | 'error'
): ExpandedPlaybackAction => {
    if (status === 'playing') {
        return 'pause';
    }
    if (status === 'ready' || status === 'paused') {
        return 'play';
    }
    if (status === 'ended') {
        return 'restart';
    }
    if (status === 'error') {
        return 'retry';
    }
    return 'disabled';
};

/** PlaybackControls props（全部受控回调，父级经 facade 传入）。 */
export type PlaybackControlsProps = {
    /** 主动作（ViewModel.primaryAction）。 */
    primaryAction: ExpandedPlaybackAction;
    /** 是否可从头播放（ViewModel.canRestart）。 */
    canRestart: boolean;
    /** 播放（resume 已水合断点；error 时为重试同一路径）。 */
    onPlay: () => void;
    /** 暂停。 */
    onPause: () => void;
    /** 从头播放（Work 新 UUID / Draft 本地 finite，spec §38）。 */
    onRestart: () => void;
    /** 后退 5 秒（当前 Segment 内 seek）。 */
    onSeekBackward: () => void;
    /** 前进 5 秒（当前 Segment 内 seek）。 */
    onSeekForward: () => void;
};

const actionLabel: Record<ExpandedPlaybackAction, string> = {
    play: '播放',
    pause: '暂停',
    restart: '再次播放',
    retry: '重试播放',
    disabled: '正在准备语音',
};

export const PlaybackControls: React.FC<PlaybackControlsProps> = ({
    primaryAction,
    canRestart,
    onPlay,
    onPause,
    onRestart,
    onSeekBackward,
    onSeekForward,
}) => {
    const isBusy = primaryAction === 'disabled';
    const isEnded = primaryAction === 'restart';
    // ended 时主播放键置灰（需经从头播放重开）；其余按动作映射。
    const playDisabled = isBusy || isEnded;
    const pauseDisabled = isBusy || primaryAction !== 'pause';
    const seekDisabled = isBusy;
    const restartDisabled = isBusy || !canRestart;

    const handlePrimary = (): void => {
        if (primaryAction === 'pause') {
            onPause();
            return;
        }
        if (primaryAction === 'play' || primaryAction === 'retry') {
            onPlay();
            return;
        }
        if (primaryAction === 'restart') {
            onRestart();
        }
    };

    const PrimaryIcon = primaryAction === 'pause' ? Pause : primaryAction === 'restart' ? RotateCcw : primaryAction === 'retry' ? RotateCw : Play;

    return (
        <div data-testid="expanded-playback-controls">
            <button
                type="button"
                data-testid="expanded-seek-back"
                onClick={onSeekBackward}
                disabled={seekDisabled}
                aria-label="后退 5 秒"
                title="后退 5 秒"
            >
                <Rewind size={20} aria-hidden="true" />
            </button>
            <button
                type="button"
                data-testid="expanded-play-button"
                onClick={handlePrimary}
                disabled={playDisabled && pauseDisabled}
                aria-label={actionLabel[primaryAction]}
            >
                <PrimaryIcon size={28} aria-hidden="true" />
            </button>
            <button
                type="button"
                data-testid="expanded-seek-forward"
                onClick={onSeekForward}
                disabled={seekDisabled}
                aria-label="前进 5 秒"
                title="前进 5 秒"
            >
                <FastForward size={20} aria-hidden="true" />
            </button>
            <button
                type="button"
                data-testid="expanded-restart-button"
                onClick={onRestart}
                disabled={restartDisabled}
                aria-label="从头播放"
                title="从头播放"
            >
                <RotateCcw size={20} aria-hidden="true" />
            </button>
        </div>
    );
};

export default PlaybackControls;
