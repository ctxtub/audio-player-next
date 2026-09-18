'use client';

/**
 *  MiniNowPlaying 正式实现（spec §2.3/§3/§4/§5/§6/§9/§10/§11/§24/§33）
 * +  Wide Floating（spec §18/§19）。
 *
 * 语义冻结：
 * - 显隐只派生：source 非空且 status 非 idle（PlaybackSessionStore.current session）。
 *   禁止第二套持久/业务显隐状态（浮窗显隐标记与 show/hide 命令一律不得存在）。
 * - title 仅取 Session.title；position 仅取 Session 语义位置；
 *   播放/暂停与当前段时间进度仅取 playbackStore Transport（播放标记/当前时间/总时长）；
 *   睡眠预算字段不在 Mini 展示。
 * - 动作一律走  PlaybackSessionFlow（pausePlayback/resumePlayback/restartPlayback），
 *   不直调 AudioControllerHost，不知晓水合技术状态。
 * - Metadata 点击经 useNowPlayingEntry → /player（ 兼容， 只换 facade）。
 * - Draft / Work 不做视觉分叉（§33）。
 * - Wide Floating（§18）：viewport>=768 且 desktopFloatingPlayerEnabled=true →
 *   wide-floating（position:fixed、width:var(--size-mini-now-playing-wide)、
 *   z-index:var(--z-floating)）；初始 CSS 右下（right:var(--space-4)；
 *   bottom:calc(tab-bar-safe-bottom + var(--space-4))），用户首次 drag 后转
 *   left/top 内联坐标；仅 DragGrip 绑定 useDrag，Playback/Metadata 按钮不参与；
 *   drag 期间/结束 clamp，结束吸附最近水平边，resize re-clamp；位置 localStorage
 *   持久化 + refresh restore（useMiniFloatingDrag，容错 fallback 默认右下）；
 *   纯 presentation，不 mutation
 *   session/transport。
 * - Wide Docked（§19）：pref=false → wide-docked，固定 TabBar 上方（与移动端一致）；
 *   配置只决定桌面是否漂浮，不决定 Now Playing 是否存在。
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
import { useMiniFloatingDrag } from './useMiniFloatingDrag';
import { useNowPlayingEntry } from './useNowPlayingEntry';
import { useNowPlayingLayoutMode } from './useNowPlayingLayoutMode';
import styles from './MiniNowPlaying.module.scss';

/**
 * Mini 主动作 →  Flow 委托（spec §10/§11）。
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
 * Global Mini Now Playing（ 收官 + FloatingPlayer 仅留 deprecated 兼容 shim，正式命名唯一）。
 * 无 current session → 返回 null（不渲染）；config 只决定 layoutMode，不决定存在性。
 * Wide Floating 坐标仅在 wide-floating + 已拖拽时以内联 left/top 应用；
 * docked/compact 一律走 CSS 默认（旧 floating 坐标不残留，跨 768 往返合法）。
 */
export const MiniNowPlaying: React.FC = () => {
    const source = usePlaybackSessionStore((state) => state.source);
    const title = usePlaybackSessionStore((state) => state.title);
    const collectionTitle = usePlaybackSessionStore((state) => state.collectionTitle);
    const workTitle = usePlaybackSessionStore((state) => state.workTitle);
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
    //  floating drag：hook 恒挂载（跨 mode 保留内存坐标），手势仅 floating 生效。
    const isFloating = layoutMode === 'wide-floating';
    const floating = useMiniFloatingDrag(isFloating);

    const viewModel = deriveMiniNowPlayingViewModel(
        {
            source,
            status: sessionStatus,
            title,
            collectionTitle,
            workTitle,
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

    // 仅 floating + 已拖拽才应用 left/top；docked/compact 与 floating 默认态一律 CSS。
    const hasDraggedPosition = isFloating && floating.position !== null;
    const floatingStyle = hasDraggedPosition
        ? {
                left: `${floating.position?.x ?? 0}px`,
                top: `${floating.position?.y ?? 0}px`,
            }
        : undefined;

    return (
        <div
            ref={floating.panelRef}
            className={styles.miniRoot}
            style={floatingStyle}
            data-testid="mini-now-playing"
            data-layoutmode={viewModel.layoutMode}
            data-status={viewModel.status}
            data-dragged={hasDraggedPosition ? 'true' : 'false'}
            data-dragging={floating.isDragging ? 'true' : 'false'}
        >
            {isFloating ? (
                <div
                    className={styles.dragGrip}
                    data-testid="mini-drag-grip"
                    data-dragging={floating.isDragging ? 'true' : 'false'}
                    aria-label="拖动迷你播放器"
                    title="拖动迷你播放器"
                    {...floating.gripBind()}
                >
                    <span aria-hidden="true" className={styles.dragGripDots} />
                </div>
            ) : null}
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
