'use client';

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useDrag } from '@use-gesture/react';
import { Toast } from 'antd-mobile';
import PlayIcon from '@/public/icons/audioplayer-play.svg';
import PauseIcon from '@/public/icons/audioplayer-pause.svg';
import { useConfigStore } from '@/stores/configStore';
import { usePlaybackStore, useFloatingPlayer } from '@/stores/playbackStore';
import {
  clampValue,
  determineDockedSide,
  getDockedPosition,
  shouldSkipPointerDown,
  shouldUndock,
  FLOATING_HANDLE_SIZE,
  type DockedSide,
  type FloatingPosition,
  type PanelSize,
  type ViewportSize,
} from './utils';
import styles from './index.module.scss';

export { useFloatingPlayer } from '@/stores/playbackStore';

/**
 * 浮动播放器组件，常驻布局层维护音频播放与迷你面板。
 * @returns JSX.Element 浮动播放器节点
 */
export const FloatingPlayer: React.FC = () => {
  // 浮动面板当前位置，单位为像素
  const [position, setPosition] = useState<FloatingPosition>({ x: 16, y: 360 });
  // 是否处于拖拽中状态
  const [isDragging, setIsDragging] = useState(false);
  // 当前吸附方向，null 表示未吸附
  const [dockedSide, setDockedSide] = useState<DockedSide | null>(null);
  // 浮动面板 DOM 引用，用于读取尺寸
  const panelRef = useRef<HTMLDivElement | null>(null);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const playbackRemainingMs = usePlaybackStore((state) => state.remainingMs);
  const { resume, pause, show, hide } = useFloatingPlayer();
  const isVisible = usePlaybackStore((state) => state.isFloatingVisible);
  const isFloatingPlayerEnabled = useConfigStore(
    (state) => state.apiConfig.floatingPlayerEnabled
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    setPosition((prev) => ({
      x: prev.x,
      y: Math.max(80, window.innerHeight - 280),
    }));
  }, []);

  // 浮窗拖拽手势绑定器，负责处理拖拽开始与位置更新
  interface DragContext {
    /** 拖拽起始位置 */
    origin: FloatingPosition;
    /** 拖拽开始时的面板尺寸 */
    panelSize: PanelSize;
    /** 拖拽开始时的视口尺寸 */
    viewport: ViewportSize;
    /** 用作计算相对位移的拖拽基准 */
    movementOrigin: [number, number];
  }

  // 浮窗拖拽手势绑定器，负责处理拖拽开始与位置更新
  const bindFloatingHeaderDrag = useDrag(
    (state) => {
      const { first, last, canceled, movement, cancel, event, memo } = state;
      if (typeof window === 'undefined') {
        return memo as DragContext | null;
      }

      if (first) {
        const target = (event?.target ?? null) as EventTarget | null;
        if (shouldSkipPointerDown(target)) {
          cancel();
          return memo as DragContext | null;
        }

        const panelWidth = panelRef.current?.offsetWidth ?? 320;
        const panelHeight = panelRef.current?.offsetHeight ?? 320;
        const context: DragContext = {
          origin: { x: position.x, y: position.y },
          panelSize: { width: panelWidth, height: panelHeight },
          viewport: { width: window.innerWidth, height: window.innerHeight },
          movementOrigin: [0, 0],
        };
        setIsDragging(true);
        return context;
      }

      const context = memo as DragContext | null;
      if (!context) {
        return context;
      }

      const [movementX, movementY] = movement;
      let relativeMovementX = movementX - context.movementOrigin[0];
      let relativeMovementY = movementY - context.movementOrigin[1];
      let activeDockSide = dockedSide;
      let undockedThisFrame = false;

      const panelSize = context.panelSize;
      const viewport = context.viewport;

      if (activeDockSide !== null && shouldUndock(activeDockSide, relativeMovementX)) {
        setDockedSide(null);
        activeDockSide = null;
        undockedThisFrame = true;
        const maxX = Math.max(0, viewport.width - panelSize.width);
        const maxY = Math.max(0, viewport.height - panelSize.height);
        const newOrigin: FloatingPosition = {
          x: clampValue(context.origin.x + relativeMovementX, 0, maxX),
          y: clampValue(context.origin.y + relativeMovementY, 0, maxY),
        };
        context.origin = newOrigin;
        context.movementOrigin = [movementX, movementY];
        relativeMovementX = 0;
        relativeMovementY = 0;
      }

      const rawPosition: FloatingPosition = {
        x: context.origin.x + relativeMovementX,
        y: context.origin.y + relativeMovementY,
      };

      const maxX = Math.max(0, viewport.width - panelSize.width);
      const maxY = Math.max(0, viewport.height - panelSize.height);
      const freePosition: FloatingPosition = {
        x: clampValue(rawPosition.x, 0, maxX),
        y: clampValue(rawPosition.y, 0, maxY),
      };

      const detectionPosition = activeDockSide !== null ? rawPosition : freePosition;
      const nextDockSide = undockedThisFrame
        ? null
        : determineDockedSide(detectionPosition, panelSize, viewport);

      if (activeDockSide !== null) {
        if (nextDockSide && nextDockSide !== activeDockSide) {
          // 切换到另一侧吸附
          setDockedSide(nextDockSide);
          const dockedPosition = getDockedPosition({
            side: nextDockSide,
            position: rawPosition,
            panelSize,
            viewport,
            handleSize: FLOATING_HANDLE_SIZE,
          });
          setPosition(dockedPosition);
          return context;
        }

        if (nextDockSide === activeDockSide) {
          const dockedPosition = getDockedPosition({
            side: activeDockSide,
            position: rawPosition,
            panelSize,
            viewport,
            handleSize: FLOATING_HANDLE_SIZE,
          });
          setPosition(dockedPosition);
          return context;
        }

        const dockedPosition = getDockedPosition({
          side: activeDockSide,
          position: rawPosition,
          panelSize,
          viewport,
          handleSize: FLOATING_HANDLE_SIZE,
        });
        setPosition(dockedPosition);
        return context;
      }

      if (nextDockSide) {
        setDockedSide(nextDockSide);
        const dockedPosition = getDockedPosition({
          side: nextDockSide,
          position: rawPosition,
          panelSize,
          viewport,
          handleSize: FLOATING_HANDLE_SIZE,
        });
        setPosition(dockedPosition);
      } else {
        setPosition(freePosition);
      }

      if (last || canceled) {
        setIsDragging(false);
      }

      return context;
    },
    {
      filterTaps: true,
    }
  );

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

  // 浮窗标题展示内容，依据播放状态切换默认文案与倒计时
  const floatingTitleLabel = useMemo(() => {
    if (isPlaying && remainingTimeLabel) {
      return `${remainingTimeLabel} 后停止`;
    }
    return '快来首页创作吧';
  }, [isPlaying, remainingTimeLabel]);

  const dockedClassMap: Record<DockedSide, string> = {
    left: styles.floatingPanelDockedLeft,
    right: styles.floatingPanelDockedRight,
  };

  const floatingPanelClassName = [
    styles.floatingPanel,
    shouldShowFloatingPanel ? styles.floatingPanelExpanded : styles.floatingPanelHidden,
    isDragging ? styles.floatingPanelDragging : '',
    dockedSide ? styles.floatingPanelDocked : '',
    dockedSide ? dockedClassMap[dockedSide] : '',
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
        {...bindFloatingHeaderDrag()}
      >
        <div className={styles.floatingHandle} aria-hidden={dockedSide === null}>
          <span className={styles.floatingHandleBar} />
        </div>
        <div className={styles.floatingHeader}>
          <div className={styles.floatingTitle}>{floatingTitleLabel}</div>
          <div className={styles.floatingActions}>
            <button
              type="button"
              className={styles.floatingActionButton}
              aria-label={isPlaying ? '暂停播放' : '继续播放'}
              onClick={togglePlay}
            >
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
