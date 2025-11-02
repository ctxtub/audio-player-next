'use client';

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Toast } from 'antd-mobile';
import { PlayOutline, StopOutline, MoreOutline } from 'antd-mobile-icons';
import { useRouter } from 'next/navigation';
import { useConfigStore } from '@/stores/configStore';
import { useStoryStore } from '@/stores/storyStore';
import { usePlaybackStore, useFloatingPlayer } from '@/stores/playbackStore';
import {
  attachDragListeners,
  createDragBoundary,
  createDragState,
  shouldSkipPointerDown,
  type DragState,
  type FloatingPosition,
} from './utils';
import styles from './index.module.scss';

export { useFloatingPlayer } from '@/stores/playbackStore';

/**
 * 浮动播放器组件，常驻布局层维护音频播放与迷你面板。
 * @returns JSX.Element 浮动播放器节点
 */
export const FloatingPlayer: React.FC = () => {
  const router = useRouter();
  // 浮动面板当前位置，单位为像素
  const [position, setPosition] = useState<FloatingPosition>({ x: 16, y: 360 });
  // 是否处于拖拽中状态
  const [isDragging, setIsDragging] = useState(false);
  // 拖拽起点及面板原始位置记录
  const dragStateRef = useRef<DragState | null>(null);
  // 浮动面板 DOM 引用，用于读取尺寸
  const panelRef = useRef<HTMLDivElement | null>(null);
  const storySegments = useStoryStore((state) => state.segments);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const playbackRemainingMs = usePlaybackStore((state) => state.remainingMs);
  const { resume, pause, show, hide } = useFloatingPlayer();
  const isVisible = usePlaybackStore((state) => state.isFloatingVisible);
  const isFloatingPlayerEnabled = useConfigStore(
    (state) => state.apiConfig.floatingPlayerEnabled
  );
  const currentStoryPreview = Array.isArray(storySegments) ? storySegments.at(-1) ?? '' : storySegments;

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    setPosition((prev) => ({
      x: prev.x,
      y: Math.max(80, window.innerHeight - 280),
    }));
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (shouldSkipPointerDown(event.target)) {
        return;
      }
      dragStateRef.current = createDragState(event, position);
      setIsDragging(true);
    },
    [position]
  );

  useEffect(() => {
    if (!isDragging) {
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }
    return attachDragListeners({
      dragStateRef,
      onDrag: setPosition,
      onDragEnd: () => setIsDragging(false),
      createBoundary: () =>
        createDragBoundary({
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          panelWidth: panelRef.current?.offsetWidth,
          panelHeight: panelRef.current?.offsetHeight,
        }),
    });
  }, [isDragging]);

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      pause();
    } else {
      resume().catch((error) => {
        const message = error instanceof Error ? error.message : '无法恢复播放';
        Toast.show({ icon: 'fail', content: message, duration: 3000 });
      });
    }
  }, [isPlaying, pause, resume]);

  const handleOpenFullPlayer = useCallback(() => {
    router.push('/player');
  }, [router]);

  useEffect(() => {
    if (isFloatingPlayerEnabled) {
      if (!isVisible) {
        show();
      }
      return;
    }
    if (isVisible) {
      hide();
    }
  }, [hide, isFloatingPlayerEnabled, isVisible, show]);

  // 剩余播放时长文本，转化为 mm:ss 样式
  const remainingTimeLabel = useMemo(() => {
    if (playbackRemainingMs === null) {
      return null;
    }
    const totalSeconds = Math.max(0, Math.ceil(playbackRemainingMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const minutesLabel = minutes.toString().padStart(2, '0');
    const secondsLabel = seconds.toString().padStart(2, '0');
    return `${minutesLabel}:${secondsLabel}`;
  }, [playbackRemainingMs]);

  const shouldShowFloatingPanel = isFloatingPlayerEnabled && isVisible;

  const floatingPanelClassName = [
    styles.floatingPanel,
    shouldShowFloatingPanel ? styles.floatingPanelExpanded : styles.floatingPanelHidden,
    isDragging ? styles.floatingPanelDragging : '',
  ].join(' ');

  return (
    <div className={styles.floatingRoot} aria-hidden={!shouldShowFloatingPanel}>
      <div
        ref={panelRef}
        className={floatingPanelClassName}
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
        }}
      >
        <div className={styles.floatingHeader} onPointerDown={handlePointerDown}>
          <div className={styles.floatingTitle}>{currentStoryPreview || '快来首页创作故事吧'}</div>
          <div className={styles.floatingActions}>
            <button
              type="button"
              className={styles.floatingActionButton}
              aria-label={isPlaying ? '暂停播放' : '继续播放'}
              onClick={togglePlay}
            >
              {isPlaying ? <StopOutline /> : <PlayOutline />}
            </button>
            <button
              type="button"
              className={styles.floatingActionButton}
              aria-label="查看播放器详情"
              onClick={handleOpenFullPlayer}
            >
              <MoreOutline />
            </button>
          </div>
        </div>
        <div className={styles.floatingBodyExpanded}>
          {remainingTimeLabel !== null && (
            <div className={styles.miniHint}>剩余时长 {remainingTimeLabel}</div>
          )}
        </div>
      </div>
    </div>
  );
};
