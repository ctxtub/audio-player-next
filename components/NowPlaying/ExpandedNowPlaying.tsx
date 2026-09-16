'use client';

/**
 *  ExpandedNowPlaying（spec §10/§11 基础 Surface + §42 Focus + §9 关闭语义）
 * +   Playback Capabilities（spec §16/§17/§20/§38/§39 additive）。
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
 * -  播放能力（本轮新增，经 useExpandedPlaybackControls facade 消费）：
 *   当前 Segment timeline（本段，不伪装整篇）/ click+keyboard seek 全 clamp /
 *   Play-Pause-从头播放 / 七档 Session 级倍速 / 段落 badge；明确无上一段/
 *   下一段（spec §40），无 story-level timeline（）。
 *
 *  ownership 边界：
 * - 本文件只读 ViewModel + UI Store 关闭动作 + facade 回调；
 * - 不直调 playbackSessionFlow / AudioControllerHost / playbackStore 写面 /
 *   <audio> / Session 字段（全部经 facade → flow → Session+Host）；
 * - 不建 Expanded-local speed state；不写回 UserConfig；不触 StoryWork/progress identity。
 *
 *  Work 查看正文（spec §33-§34 / §44 additive）：
 * - Work source 即展示「查看正文」（目标 = ViewModel.viewStoryTarget，
 *   由 source.workId 直接派生）；Draft/空 source 不展示；
 * - 点击顺序固定：closeExpanded() 先行 → 已在同一 /library/[workId] 则止步，
 *   否则 router.push(target)；全程不改播放状态（播放继续）。
 *
 *  Draft Transcript（spec §35 / §35.1 / §72 additive）：
 * - Draft source（含可用 storyText）即经 Actions 展示同文案「查看正文」
 *（独立 testid，Transcript 口）；点击只切 Expanded 内部局部 view state
 *   controls → transcript，不导航（URL 不变）、不拼凑 /library/[fake-id]、
 *   不写 global UI Store（nowPlayingUiStore 无新增字段）；
 * - TranscriptView 只读展示 ViewModel.transcriptText（=  Session.storyText
 *   原文）；返回控制只切回 controls，不改 Session/Transport/Audio；
 * - promotion（source 切 work，sessionId 不变）不强制关闭 transcript
 *（局部 view 只按 sessionId 与 Expanded 开关重置）；promotion 后
 *   viewStoryTarget 非空时 transcript 内展示「打开作品详情」入口（复用
 *   handleViewStory 同一路由出口； 真实 promotion 触发面在 Expanded 外，
 *   本文件只保证不强制关闭 + 入口复用，不越界）。
 *
 *  Creation Actions Boundary（spec §36/§36.2/§37/§75/ additive）：
 * - Draft「返回创作」（§37）：Draft 面经 Actions 与「查看正文」同容器并存
 *（独立 testid）；点击 = handleBackToCreation（closeExpanded 先行 →
 *   router.push('/chat')），绝不自动发送新 Prompt（无 send 调用、无预填
 *   即发、无消息追加），播放继续（不 pause，会话/进度/音频宿主全不变）；
 * - Work「继续创作」（§36.2/）：只消费  `continueFromStoryWork`
 *   契约；契约未落地前隐藏 CTA（fail-closed，本文件不装配 continuation
 *   Prompt、不直调任何 continuation，不暂停播放 §36.3）； 落地后经预留
 *   onContinueCreation 缝合即可，不改播放架构。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, Modal as AriaModal, ModalOverlay } from 'react-aria-components';
import { useDrag } from '@use-gesture/react';
import { usePathname, useRouter } from 'next/navigation';
import { Headphones } from 'lucide-react';

import { useNowPlayingUiStore } from '@/stores/nowPlayingUiStore';

import { NowPlayingHeader } from './NowPlayingHeader';
import { ParagraphStatus } from './ParagraphStatus';
import { PlaybackControls } from './PlaybackControls';
import { PlaybackRateControl } from './PlaybackRateControl';
import { SleepTimerControl } from './SleepTimerControl';
import { NowPlayingActions } from './NowPlayingActions';
import { TranscriptView } from './TranscriptView';
import { CHAT_ROUTE } from './creationActions';
import { isSameLibraryDetail } from './workViewStoryNavigation';
import { PlaybackTimeline, EXPANDED_TIMELINE_KEYBOARD_STEP_SECONDS } from './PlaybackTimeline';
import { useExpandedPlaybackControls } from './useExpandedPlaybackControls';
import { useExpandedNowPlayingViewModel } from './useExpandedNowPlayingViewModel';
import styles from './ExpandedNowPlaying.module.scss';

/** Expanded 内部局部视图（spec §35：controls ↔ transcript，不进 global UI Store）。 */
export type ExpandedLocalView = 'controls' | 'transcript';

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

/** 组装二级文案：voice · 第 X / Y 段（ 明确段定位，不伪装整篇）。 */
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
    //   facade：唯一播放写面（UI→flow→Session+Host；本文件不直调 store/audio）。
    const controls = useExpandedPlaybackControls();
    //  内容导航路由（查看正文 push 唯一来源；播放写面仍走 facade）。
    const router = useRouter();
    const pathname = usePathname();

    const [dragOffsetY, setDragOffsetY] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    //  Expanded 内部局部 view state（spec §35：不进 global UI Store；
    // 只按 sessionId 与 Expanded 开关重置，promotion 同 sessionId 保持打开）。
    const [expandedView, setExpandedView] = useState<ExpandedLocalView>('controls');
    const dragOffsetRef = useRef(0);
    dragOffsetRef.current = dragOffsetY;
    // Escape 兜底的事实判断锚点（Blocking 3）：用真实 overlay/dialog ref 做 contains，
    // 不依赖 testid query。
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const dialogRef = useRef<HTMLElement | null>(null);

    const handleClose = useCallback(() => {
        // 只关闭 UI，不暂停/不 clear Session（spec §9：播放继续）。
        //：关闭即回落 controls（下次打开从控制面进入）。
        setExpandedView('controls');
        setDragOffsetY(0);
        setIsDragging(false);
        closeExpanded();
    }, [closeExpanded]);

    /**
     *  查看正文（spec §34 / §44）：
     * closeExpanded() 先行 → 同 Detail 去重（只 close）→ 否则 push 目标。
     * 只动 UI 开关与路由，不触播放状态（播放继续，不 pause）。
     */
    const handleViewStory = useCallback(() => {
        const target = viewModel.viewStoryTarget;
        if (target === null) {
            return;
        }
        handleClose();
        if (typeof pathname === 'string' && isSameLibraryDetail(pathname, target)) {
            return;
        }
        router.push(target);
    }, [viewModel.viewStoryTarget, handleClose, pathname, router]);

    /**
     *  Draft 查看正文 → transcript（spec §35/§72）：
     * 只切 Expanded 内部局部 view（controls → transcript），不导航
     *（URL 不变）、不拼凑 /library 目标、不改 Session/Transport/Audio、
     * 不写 global UI Store。
     */
    const handleViewTranscript = useCallback(() => {
        setExpandedView('transcript');
    }, []);

    /**
     *  返回控制（spec §72）：
     * 只切回 controls，不改变 Session（sessionId/status/source 全不动）。
     */
    const handleBackToControls = useCallback(() => {
        setExpandedView('controls');
    }, []);

    /**
     *  Draft 返回创作（spec §37 / §44）：
     * closeExpanded() 先行 → router.push('/chat')；绝不自动发送新 Prompt
     *（无 send 调用、无预填即发、无消息追加），播放继续（不 pause，
     * 不改 Session/Transport/Audio，只动 UI 开关与路由）。
     */
    const handleBackToCreation = useCallback(() => {
        handleClose();
        router.push(CHAT_ROUTE);
    }, [handleClose, router]);

    //  局部 view 重置（只按 sessionId 与 Expanded 开关）：
    // - 新 Session（sessionId 变化）→ 回落 controls；
    // - promotion（source 切 work 但 sessionId 不变）→ 保持 transcript 打开（§35.1）；
    // - Expanded 关闭 → 回落 controls（下次打开从控制面进入）。
    const sessionIdForView = viewModel.sessionId;
    useEffect(() => {
        setExpandedView('controls');
    }, [sessionIdForView]);
    useEffect(() => {
        if (!isExpanded) {
            setExpandedView('controls');
        }
    }, [isExpanded]);

    const handleOverlayOpenChange = useCallback(
        (open: boolean) => {
            if (!open) {
                handleClose();
            }
        },
        [handleClose]
    );

    /**
     * Escape 兜底（ 复验修复 + Blocking 3 收窄）：
     * RAC overlay 的 Escape 语义要求焦点位于 overlay 内；真实浏览器中，点击
     *「从头播放」等操作会让 busy 控件 disabled，浏览器随即把焦点移到 body
     *（标准行为），窗口期内 Escape 冒泡不经过 overlay → RAC handler 不触发
     * → 面板无法关闭。
     * 本监听为纯兜底且必须收窄为「焦点确实不在 Expanded overlay 内」才接管：
     * - RAC 已处理（焦点在 overlay 内）时事件已 preventDefault → 让行；
     * - 焦点仍在 overlay/dialog 内（含 nested menu/popover）→ 让行（交由
     *   RAC 与局部控件处理，不得抢先关闭整个面板）；
     * - 仅当焦点逃出 overlay（如掉到 body）才走同一 handleClose。
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
            const active = typeof document !== 'undefined' ? (document.activeElement as Node | null) : null;
            const insideOverlay =
                overlayRef.current !== null && active !== null && overlayRef.current.contains(active);
            const insideDialog =
                dialogRef.current !== null && active !== null && dialogRef.current.contains(active);
            if (insideOverlay || insideDialog) {
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

    //  transcript 是否展示「打开作品详情」（§35.1：仅 promotion 后
    // viewStoryTarget 非空时展示，复用同一 handleViewStory 路由出口）。
    const transcriptOpenDetail =
        expandedView === 'transcript' && viewModel.viewStoryTarget !== null
            ? handleViewStory
            : null;

    return (
        <ModalOverlay
            ref={overlayRef}
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
                    ref={dialogRef}
                    className={styles.dialog}
                    aria-label={EXPANDED_DIALOG_ARIA_LABEL}
                    data-testid="expanded-now-playing"
                    data-status={viewModel.sessionStatus}
                    data-view={expandedView}
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
                            {expandedView === 'transcript' ? (
                                /*  Draft Transcript 只读面（spec §35/§72：
                                   与 controls 互斥的 Expanded-local view：
                                   transcript open 时 controls 元素完全不渲染；
                                   内容 = Session.storyText 原文；返回控制只切局部 view；
                                   promotion 后仅「打开作品详情」CTA，不与「查看正文」并存）。 */
                                <TranscriptView
                                    storyText={viewModel.transcriptText}
                                    onBack={handleBackToControls}
                                    onOpenWorkDetail={transcriptOpenDetail}
                                    disabled={!viewModel.hasSession}
                                />
                            ) : (
                                <>
                            <div className={styles.artworkStage} aria-hidden="true">
                                <div className={styles.artworkGlow} />
                                <div className={styles.artworkDisc}>
                                    <Headphones size={40} strokeWidth={1.5} />
                                </div>
                            </div>
                            <div className={styles.statusLine} data-testid="expanded-status">
                                {viewModel.isEnded ? '播放完成' : subtitle}
                            </div>
                            <div
                                className={styles.paragraphLine}
                                data-testid="expanded-paragraph"
                            >
                                {`第 ${viewModel.paragraph.current} / ${viewModel.paragraph.total} 段`}
                            </div>
                            {/*   段落 badge（spec §39，与 Mini 同公式的结构化表达）。 */}
                            <ParagraphStatus
                                current={viewModel.paragraph.current}
                                total={viewModel.paragraph.total}
                            />
                            {/*   当前 Segment timeline（本段，不伪装整篇，spec §17/§68）。 */}
                            <PlaybackTimeline
                                currentTime={viewModel.timeline.currentTime}
                                duration={viewModel.timeline.duration}
                                onSeek={controls.seekCurrentSegment}
                                disabled={!viewModel.hasSession}
                            />
                            {/*   播放控制（Play/Pause/±5s/从头播放；无上一段/下一段，spec §40）。 */}
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
                            {/*   Session 级倍速（七档，不写回 UserConfig，不触发新 TTS）。 */}
                            <PlaybackRateControl
                                currentRate={viewModel.playbackRate}
                                onSelect={controls.setPlaybackRate}
                                disabled={!viewModel.hasSession}
                            />
                            {/*   Expanded 快捷 Timer（spec §31.1/§32：只改当前 Session，不改 Settings 默认）。 */}
                            <SleepTimerControl
                                mode={viewModel.sleepTimer.mode}
                                remainingMs={viewModel.sleepTimer.remainingMs}
                                isWork={viewModel.sleepTimer.isWork}
                                onSelect={controls.setSleepTimer}
                                disabled={!viewModel.hasSession}
                            />
                            {/*  Work 查看正文（spec §34：Work 导航口冻结）+
                                 Draft 查看正文（spec §35：Transcript 口，
                                同文案独立 testid，点击只切局部 view，不导航）+
                                 Draft 返回创作（spec §37：与查看正文同容器
                                并存，独立 testid，点击先关后导 /chat，零自动发送）/
                                Work 继续创作隐藏（spec §36.2 fail-closed：本文件不传
                                onContinueCreation，不拼 continuation Prompt）。
                                transcript view 下不渲染（互斥，与「打开作品详情」不并存）。 */}
                            <NowPlayingActions
                                source={viewModel.source}
                                onViewStory={handleViewStory}
                                storyText={viewModel.transcriptText}
                                status={viewModel.sessionStatus}
                                onViewTranscript={handleViewTranscript}
                                onBackToCreation={handleBackToCreation}
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
                                </>
                            )}
                        </div>
                    </div>
                </Dialog>
            </AriaModal>
        </ModalOverlay>
    );
};

export default ExpandedNowPlaying;
