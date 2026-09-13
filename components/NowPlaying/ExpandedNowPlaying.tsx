'use client';

/**
 * M7-01 ExpandedNowPlaying（spec §10/§11 基础 Surface + §42 Focus + §9 关闭语义）
 * + M7-02 P3A Playback Capabilities（spec §16/§17/§20/§38/§39 additive）。
 *
 * 职责：
 * - Modal Bottom Sheet（<768）/ Modal Right Side Panel（>=768）单一语义，
 *   CSS 断点切换，JS 不重挂载（resize 时 isExpanded 不变，spec §76）；
 * - react-aria-components ModalOverlay/Modal/Dialog 提供 focus containment /
 *   Escape / overlay semantics（spec §10.1），不自研 focus trap；
 * - 打开不改变播放，关闭/Escape/backdrop/下滑一律不暂停（spec §9）；
 * - 移动 drag dismiss 只能由顶部 Handle 发起（spec §10.2），内容区滚动不触发；
 * - Header：title ← Session.title（空回退“正在播放”），voice ← Session.voiceId
 *   经 voiceOptions lookup（找不到显示 voiceId，再回退 AI 语音，spec §15）；
 * - P3A 播放能力（本轮新增，经 useExpandedPlaybackControls facade 消费 M5）：
 *   当前 Segment timeline（本段，不伪装整篇）/ click+keyboard seek 全 clamp /
 *   Play-Pause-从头播放 / 七档 Session 级倍速 / 段落 badge；明确无上一段/
 *   下一段（spec §40），无 story-level timeline（M8 P3B）。
 *
 * M5 ownership 边界：
 * - 本文件只读 ViewModel + UI Store 关闭动作 + facade 回调；
 * - 不直调 playbackSessionFlow / AudioControllerHost / playbackStore 写面 /
 *   <audio> / Session 字段（全部经 facade → flow → Session+Host）；
 * - 不建 Expanded-local speed state；不写回 UserConfig；不触 StoryWork/progress identity。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, Modal as AriaModal, ModalOverlay } from 'react-aria-components';
import { useDrag } from '@use-gesture/react';

import { useNowPlayingUiStore } from '@/stores/nowPlayingUiStore';

import { NowPlayingHeader } from './NowPlayingHeader';
import { ParagraphStatus } from './ParagraphStatus';
import { PlaybackControls } from './PlaybackControls';
import { PlaybackRateControl } from './PlaybackRateControl';
import { PlaybackTimeline, EXPANDED_TIMELINE_KEYBOARD_STEP_SECONDS } from './PlaybackTimeline';
import { useExpandedPlaybackControls } from './useExpandedPlaybackControls';
import { useExpandedNowPlayingViewModel } from './useExpandedNowPlayingViewModel';
import styles from './ExpandedNowPlaying.module.scss';

/** 下滑关闭阈值（px）：Handle 向下拖超此值释放即关闭，否则回弹（spec §78）。 */
export const EXPANDED_SHEET_DISMISS_THRESHOLD_PX = 80;

/** Expanded 对话框无障碍标签（与 Mini aria-label 呼应）。 */
export const EXPANDED_DIALOG_ARIA_LABEL = '正在播放详情';

/**
 * 是否偏好减少动态（drag dismiss 立即收起，不做弹簧，spec §10.3）。
 * SSR 下回退 false（首帧动画由 CSS media 兜底）。
 */
const prefersReducedMotion = (): boolean => {
    try {
        if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
            return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        }
    } catch {
        // 忽略 matchMedia 异常，回退完整动画。
    }
    return false;
};

/** 组装二级文案：voice · 第 X / Y 段（P3A 明确段定位，不伪装整篇）。 */
export const formatExpandedSubtitle = (
    voiceLabel: string,
    current: number,
    total: number
): string => `${voiceLabel} · 第 ${current} / ${total} 段`;

/**
 * Global Expanded Surface（受控于 nowPlayingUiStore.isExpanded）。
 * 未打开时返回 null（不挂载 Modal，不抢焦点）；打开时挂载 Modal。
 */
export const ExpandedNowPlaying: React.FC = () => {
    const isExpanded = useNowPlayingUiStore((state) => state.isExpanded);
    const closeExpanded = useNowPlayingUiStore((state) => state.closeExpanded);
    const viewModel = useExpandedNowPlayingViewModel();
    // M7-02 P3A facade：唯一播放写面（UI→flow→Session+Host；本文件不直调 store/audio）。
    const controls = useExpandedPlaybackControls();

    const [dragOffsetY, setDragOffsetY] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    const dragOffsetRef = useRef(0);
    dragOffsetRef.current = dragOffsetY;

    const handleClose = useCallback(() => {
        // 只关闭 UI，不暂停/不 clear Session（spec §9：播放继续）。
        setDragOffsetY(0);
        setIsDragging(false);
        closeExpanded();
    }, [closeExpanded]);

    const handleOverlayOpenChange = useCallback(
        (open: boolean) => {
            if (!open) {
                handleClose();
            }
        },
        [handleClose]
    );

    /**
     * Escape 兜底（M7-02 复验修复）：
     * RAC overlay 的 Escape 语义要求焦点位于 overlay 内；真实浏览器中，点击
     * 「从头播放」等操作会让 busy 控件 disabled，浏览器随即把焦点移到 body
     * （标准行为），窗口期内 Escape 冒泡不经过 overlay → RAC handler 不触发
     * → 面板无法关闭（spec §6/§77「Escape close」契约缺口；chromium 重复运行
     * 复现率约 1/5–1/8，焦点掉 body 时 100% 复现）。
     * 本监听为纯兜底：RAC 已处理时事件已被 preventDefault/stopPropagation，
     * 直接让行（不重复关闭）；仅当焦点掉出 overlay 时走同一 handleClose。
     * 不改变任何焦点行为，不替代/复制 RAC 的 focus containment（spec §10.1）。
     */
    useEffect(() => {
        if (!isExpanded) {
            return undefined;
        }
        const onDocumentKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) {
                return;
            }
            handleClose();
        };
        document.addEventListener('keydown', onDocumentKeyDown);
        return () => document.removeEventListener('keydown', onDocumentKeyDown);
    }, [isExpanded, handleClose]);

    // 移动 Sheet drag：仅 Handle 绑定（内容区/controls 不 spread）。
    // 向下拖超阈值释放 → 关闭；不足 → 回弹（reduced-motion 下立即收起/回弹，无弹簧）。
    const bindHandleDrag = useDrag(
        (gesture) => {
            const movementY = gesture.movement?.[1] ?? 0;
            if (gesture.first) {
                setIsDragging(true);
            }
            // 只响应向下拖（向上拖钳制 0，不上滑 ekspand）。
            const nextOffset = Math.max(0, movementY);
            if (gesture.last) {
                setIsDragging(false);
                if (nextOffset >= EXPANDED_SHEET_DISMISS_THRESHOLD_PX) {
                    // reduced-motion 与常规一致：阈值超即关闭（CSS 已禁动画，立即收起）。
                    void prefersReducedMotion();
                    setDragOffsetY(0);
                    handleClose();
                } else {
                    // 不足阈值：回弹（无弹簧，立即归位；CSS transition 已在 dragging=false 时恢复）。
                    setDragOffsetY(0);
                }
                return undefined;
            }
            if (gesture.active) {
                setDragOffsetY(nextOffset);
            }
            return undefined;
        },
        {
            axis: 'y',
            filterTaps: true,
        } as Parameters<typeof useDrag>[1]
    );

    if (!isExpanded) {
        return null;
    }

    const subtitle = formatExpandedSubtitle(
        viewModel.voiceLabel,
        viewModel.paragraph.current,
        viewModel.paragraph.total
    );

    // drag 位移仅作用于 Sheet（跟手），释放后关闭/回弹；桌面 Panel 经 CSS 隐藏 Handle，
    // 位移在桌面视口下无视觉影响（Handle display:none，不可发起）。
    const sheetStyle =
        dragOffsetY > 0
            ? { transform: `translateY(${dragOffsetY}px)` }
            : undefined;

    return (
        <ModalOverlay
            className={styles.overlay}
            isOpen={isExpanded}
            onOpenChange={handleOverlayOpenChange}
            isDismissable
            data-testid="expanded-overlay"
        >
            <AriaModal
                className={styles.sheet}
                data-testid="expanded-sheet"
                data-dragging={isDragging ? 'true' : 'false'}
                style={sheetStyle}
            >
                <Dialog
                    className={styles.dialog}
                    aria-label={EXPANDED_DIALOG_ARIA_LABEL}
                    data-testid="expanded-now-playing"
                    data-status={viewModel.sessionStatus}
                    data-ended={viewModel.isEnded ? 'true' : 'false'}
                >
                    <div className={styles.content}>
                        <NowPlayingHeader
                            title={viewModel.title}
                            subtitle={subtitle}
                            onClose={handleClose}
                            dragHandleProps={
                                bindHandleDrag() as unknown as Record<string, unknown>
                            }
                            isDragging={isDragging}
                        />
                        <div
                            className={styles.body}
                            data-testid="expanded-body"
                            // 内容区滚动手势不触发 dismiss（spec §10.2/§78）：
                            // 此处不 spread 任何 drag 绑定，仅 Handle 可发起。
                        >
                            <div className={styles.statusLine} data-testid="expanded-status">
                                {viewModel.isEnded ? '播放完成' : subtitle}
                            </div>
                            <div
                                className={styles.paragraphLine}
                                data-testid="expanded-paragraph"
                            >
                                {`第 ${viewModel.paragraph.current} / ${viewModel.paragraph.total} 段`}
                            </div>
                            {/* M7-02 P3A 段落 badge（spec §39，与 Mini 同公式的结构化表达）。 */}
                            <ParagraphStatus
                                current={viewModel.paragraph.current}
                                total={viewModel.paragraph.total}
                            />
                            {/* M7-02 P3A 当前 Segment timeline（本段，不伪装整篇，spec §17/§68）。 */}
                            <PlaybackTimeline
                                currentTime={viewModel.timeline.currentTime}
                                duration={viewModel.timeline.duration}
                                onSeek={controls.seekCurrentSegment}
                                disabled={!viewModel.hasSession}
                            />
                            {/* M7-02 P3A 播放控制（Play/Pause/±5s/从头播放；无上一段/下一段，spec §40）。 */}
                            <PlaybackControls
                                primaryAction={viewModel.primaryAction}
                                canRestart={viewModel.canRestart}
                                onPlay={controls.play}
                                onPause={controls.pause}
                                onRestart={controls.restart}
                                onSeekBackward={() =>
                                    controls.seekRelative(-EXPANDED_TIMELINE_KEYBOARD_STEP_SECONDS)
                                }
                                onSeekForward={() =>
                                    controls.seekRelative(EXPANDED_TIMELINE_KEYBOARD_STEP_SECONDS)
                                }
                            />
                            {/* M7-02 P3A Session 级倍速（七档，不写回 UserConfig，不触发新 TTS）。 */}
                            <PlaybackRateControl
                                currentRate={viewModel.playbackRate}
                                onSelect={controls.setPlaybackRate}
                                disabled={!viewModel.hasSession}
                            />
                            {viewModel.isEnded ? (
                                <div
                                    className={styles.endedBadge}
                                    data-testid="expanded-ended-badge"
                                >
                                    播放完成 · 再次播放请回 Mini
                                </div>
                            ) : null}
                            <div className={styles.hintLine} data-testid="expanded-hint">
                                关闭后播放继续
                            </div>
                        </div>
                    </div>
                </Dialog>
            </AriaModal>
        </ModalOverlay>
    );
};

export default ExpandedNowPlaying;
