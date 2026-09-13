'use client';

/**
 * M6-02 MiniNowPlaying 正式实现（spec §2.3/§3/§4/§5/§6/§9/§10/§11/§24/§33）。
 *
 * 语义冻结：
 * - 显隐只派生：source 非空且 status 非 idle（PlaybackSessionStore.current session）。
 *   禁止第二套持久/业务显隐状态（浮窗显隐标记与 show/hide 命令一律不得存在）。
 * - title 仅取 Session.title；position 仅取 Session 语义位置；
 *   播放/暂停与当前段时间进度仅取 playbackStore Transport（播放标记/当前时间/总时长）；
 *   睡眠预算字段不在 Mini 展示。
 * - 动作一律走 M5 PlaybackSessionFlow（pausePlayback/resumePlayback/restartPlayback），
 *   不直调 AudioControllerHost，不知晓水合技术状态。
 * - Metadata 点击经 useNowPlayingEntry → /player（M6 兼容，M7 只换 facade）。
 * - Draft / Work 不做视觉分叉（§33）。
 *
 * 本文件只做 presentation + Flow delegation；历史播放面（旧进度/历史/卡片）
 * 一律不得引入；不读写 Transport 侧 deprecated identity 镜像；
 * 不直接写 session 持久字段（只经 Flow actions）。
 */

import React, { useCallback } from 'react';

import GlassToast from '@/components/ui/GlassToast';
import { pausePlayback, resumePlayback, restartPlayback } from '@/app/services/playbackSessionFlow';
import { useConfigStore } from '@/stores/configStore';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import { usePlaybackStore } from '@/stores/playbackStore';

import { deriveMiniNowPlayingViewModel } from './deriveMiniNowPlayingViewModel';
import { MiniMetadataButton, MiniPlaybackButton } from './presentation';
import { useNowPlayingEntry } from './useNowPlayingEntry';
import { useNowPlayingLayoutMode } from './useNowPlayingLayoutMode';
import styles from './MiniNowPlaying.module.scss';

/**
 * Mini 主动作 → M5 Flow 委托（spec §10/§11）。
 * playing → pausePlayback；ready/paused → resumePlayback；
 * ended → restartPlayback；error → resumePlayback（retry/resume path）；
 * synthesizing → disabled（按钮置灰，不触发）。
 */
const useMiniPrimaryAction = (primaryAction: 'play' | 'pause' | 'restart' | 'retry' | 'disabled') => {
    return useCallback(() => {
        if (primaryAction === 'pause') {
            try {
                pausePlayback();
            } catch (error) {
                const message = error instanceof Error ? error.message : '暂停失败，请重试';
                GlassToast.show({ icon: 'fail', content: message, duration: 3000 });
            }
            return;
        }
        if (primaryAction === 'play' || primaryAction === 'retry') {
            resumePlayback().catch((error: unknown) => {
                const message = error instanceof Error ? error.message : '语音生成稍有延迟，请重试';
                GlassToast.show({ icon: 'fail', content: message, duration: 3000 });
            });
            return;
        }
        if (primaryAction === 'restart') {
            restartPlayback().catch((error: unknown) => {
                const message = error instanceof Error ? error.message : '重播失败，请重试';
                GlassToast.show({ icon: 'fail', content: message, duration: 3000 });
            });
        }
    }, [primaryAction]);
};

/**
 * Global Mini Now Playing（正式命名；FloatingPlayer 仅为兼容 re-export）。
 * 无 current session → 返回 null（不渲染）；config 只决定 layoutMode，不决定存在性。
 */
export const MiniNowPlaying: React.FC = () => {
    const source = usePlaybackSessionStore((state) => state.source);
    const title = usePlaybackSessionStore((state) => state.title);
    const sessionStatus = usePlaybackSessionStore((state) => state.status);
    const lastCompletedParagraphIndex = usePlaybackSessionStore(
        (state) => state.lastCompletedParagraphIndex
    );
    const nextParagraphIndex = usePlaybackSessionStore((state) => state.nextParagraphIndex);
    const totalParagraphs = usePlaybackSessionStore((state) => state.totalParagraphs);

    const isPlaying = usePlaybackStore((state) => state.isPlaying);
    const currentTime = usePlaybackStore((state) => state.currentTime);
    const duration = usePlaybackStore((state) => state.duration);

    const desktopFloatingPlayerEnabled = useConfigStore(
        (state) => state.apiConfig.desktopFloatingPlayerEnabled
    );

    const layoutMode = useNowPlayingLayoutMode(desktopFloatingPlayerEnabled);
    const { openDetails } = useNowPlayingEntry();

    const viewModel = deriveMiniNowPlayingViewModel(
        {
            source,
            status: sessionStatus,
            title,
            lastCompletedParagraphIndex,
            nextParagraphIndex,
            totalParagraphs,
        },
        { isPlaying, currentTime, duration },
        layoutMode
    );

    const handlePrimaryAction = useMiniPrimaryAction(viewModel.primaryAction);

    if (!viewModel.visible) {
        return null;
    }

    return (
        <div
            className={styles.miniRoot}
            data-testid="mini-now-playing"
            data-layoutmode={viewModel.layoutMode}
            data-status={viewModel.status}
        >
            <MiniMetadataButton
                title={viewModel.title}
                secondaryLabel={viewModel.secondaryLabel}
                coarseProgress={viewModel.coarseProgress}
                onOpenDetails={openDetails}
            />
            <MiniPlaybackButton
                action={viewModel.primaryAction}
                statusLabel={viewModel.secondaryLabel ?? viewModel.title}
                onAction={handlePrimaryAction}
            />
        </div>
    );
};

export default MiniNowPlaying;
