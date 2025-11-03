'use client';

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { cx } from '@/utils/cx';
import { useDrag } from '@use-gesture/react';
import { Toast } from 'antd-mobile';
import PlayIcon from '@/public/icons/audioplayer-play.svg';
import PauseIcon from '@/public/icons/audioplayer-pause.svg';
import { useConfigStore } from '@/stores/configStore';
import { usePlaybackStore, useFloatingPlayer } from '@/stores/playbackStore';
import {
  clampValue,
  shouldSkipPointerDown,
  type FloatingPosition,
  type PanelSize,
  type ViewportSize,
} from './utils';

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
      const relativeMovementX = movementX - context.movementOrigin[0];
      const relativeMovementY = movementY - context.movementOrigin[1];

      const panelSize = context.panelSize;
      const viewport = context.viewport;

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

      setPosition(freePosition);

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

  const floatingPanelClassName = cx(
    'fixed flex w-[220px] flex-col gap-[6px] rounded-[18px] border border-[color:color-mix(in_srgb,var(--primary)_24%,var(--card-border))] bg-[color-mix(in_srgb,var(--card-background)_85%,var(--primary)_15%)] px-4 py-3 shadow-[0_10px_24px_color-mix(in_srgb,var(--primary)_22%,rgba(0,0,0,0.35))] backdrop-blur-[14px] pointer-events-auto touch-none transition-[left,top,opacity,transform] duration-200 ease-linear',
    shouldShowFloatingPanel
      ? 'w-[200px] cursor-grab max-h-[min(560px,80vh)] overflow-y-auto'
      : 'pointer-events-none -translate-x-1/2 translate-y-4 opacity-0',
    isDragging ? 'cursor-grabbing transition-none' : null
  );

  return (
    <div className="fixed inset-0 pointer-events-none z-[900]" aria-hidden={!shouldShowFloatingPanel}>
      <div
        ref={panelRef}
        className={floatingPanelClassName}
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
        }}
        {...bindFloatingHeaderDrag()}
      >
        <div className="flex items-center justify-between gap-[10px] touch-none">
          <div className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[15px] font-semibold text-[var(--foreground)]">
            {floatingTitleLabel}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border-0 bg-[var(--primary)] text-white shadow-[0_4px_12px_color-mix(in_srgb,var(--primary)_45%,transparent)] transition-[background,transform,box-shadow] duration-200 ease-in-out hover:bg-[color-mix(in_srgb,var(--primary)_80%,#ffffff_20%)] hover:shadow-[0_6px_16px_color-mix(in_srgb,var(--primary)_55%,transparent)] hover:-translate-y-px active:bg-[color-mix(in_srgb,var(--primary)_70%,#000000_10%)] active:shadow-[0_2px_8px_color-mix(in_srgb,var(--primary)_35%,transparent)] active:translate-y-0"
              aria-label={isPlaying ? '暂停播放' : '继续播放'}
              onClick={togglePlay}
            >
              {isPlaying ? <PauseIcon className="h-5 w-5" /> : <PlayIcon className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
