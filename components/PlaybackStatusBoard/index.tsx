import React, { useMemo } from 'react';
import ClockIcon from '@/public/icons/playstatus-clock.svg';
import LoadingIcon from '@/public/icons/playstatus-loading.svg';
import WarningIcon from '@/public/icons/playstatus-warning.svg';
import CheckIcon from '@/public/icons/playstatus-check.svg';
import { usePlaybackStore } from '@/stores/playbackStore';
import { usePreloadStore } from '@/stores/preloadStore';
import { useConfigStore } from '@/stores/configStore';
import { useGenerationStore } from '@/stores/generationStore';

import styles from './index.module.scss';

/**
 * 状态阶段枚举。
 */
type GenerationPhase = 'idle' | 'loading' | 'success' | 'error';

/**
 * 播放状态面板组件可选入参。
 */
interface PlaybackStatusBoardProps {
  /** 外层自定义类名 */
  className?: string;
}

/**
 * 播放状态面板组件，负责展示倒计时及文本/语音生成状态。
 * @param props 自定义样式类名
 * @returns 播放状态展示 JSX
 */
const PlaybackStatusBoard: React.FC<PlaybackStatusBoardProps> = ({ className }) => {
  /** 播放剩余毫秒数，用于倒计时展示。 */
  const playbackRemainingMs = usePlaybackStore((state) => state.remainingMs);

  /** 当前配置项，提供默认播放时长。 */
  const apiConfig = useConfigStore((state) => state.apiConfig);

  /** 预加载流程状态，判断语音生成阶段。 */
  const preloadStatus = usePreloadStore((state) => state.status);
  /** 预加载重试次数，用于提示重试进度。 */
  const preloadRetryCount = usePreloadStore((state) => state.retryCount);

  /** 生成阶段状态 */
  const generationPhase = useGenerationStore((state) => state.phase);

  const remainingTime = useMemo(() => {
    if (playbackRemainingMs === null) {
      return apiConfig.playDuration > 0 ? apiConfig.playDuration : null;
    }
    return Math.max(0, playbackRemainingMs / 60000);
  }, [apiConfig.playDuration, playbackRemainingMs]);

  /** 是否处于初始生成阶段（非空闲且非完成/错误），或者处于预加载状态。 */
  const isInitialGenerating = generationPhase === 'generating_text' || generationPhase === 'generating_audio';
  const isStoryLoading = isInitialGenerating || preloadStatus === 'loading';
  /** 是否已有已缓存的语音资源，可提示预加载成功。 */
  const hasPreloadedAudio = preloadStatus === 'ready';

  const containerClassName = className
    ? `${styles.statusContainer} ${className}`
    : styles.statusContainer;

  /**
   * 将分钟数格式化为 mm:ss 字符串。
   * @param minutes 剩余分钟数
   * @returns mm:ss 形式的时间文本
   */
  const formatCountdown = (minutes: number): string => {
    const wholeMinutes = Math.floor(minutes);
    const seconds = Math.floor((minutes - wholeMinutes) * 60);
    return `${wholeMinutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const statusItems: Array<{
    key: string;
    phase: GenerationPhase;
    message?: string;
  }> = [];

  if (remainingTime !== null) {
    statusItems.push({
      key: 'countdown',
      phase: 'success',
      message: `播放倒计时 ${formatCountdown(remainingTime)}`,
    });
  }

  if (isStoryLoading) {
    const retryInfo =
      preloadStatus === 'loading' && preloadRetryCount > 0
        ? ` (第${preloadRetryCount}次重试)`
        : '';
    statusItems.push({
      key: 'story-loading',
      phase: 'loading',
      message: `故事加载中${retryInfo}`,
    });
  }

  // 如果处于打字机/音波生成阶段，覆盖或添加状态
  if (generationPhase === 'generating_text') {
    // 移除通用的 story-loading（如果已存在），用更具体的替换
    // 不过上面的 isStoryLoading判断依赖 storySegments.length === 0
    // 在 generating_text 阶段，segments 确实为 0。
    // 我们简单过滤掉上面的 'story-loading'，或者直接在这里处理。
    const existingIndex = statusItems.findIndex(i => i.key === 'story-loading');
    if (existingIndex !== -1) {
      statusItems[existingIndex].message = '正在创作故事...';
    } else {
      statusItems.push({
        key: 'story-generating-text',
        phase: 'loading',
        message: '正在创作故事...',
      });
    }
  } else if (generationPhase === 'generating_audio') {
    const existingIndex = statusItems.findIndex(i => i.key === 'story-loading');
    if (existingIndex !== -1) {
      statusItems[existingIndex].message = '正在生成语音...';
    } else {
      statusItems.push({
        key: 'story-generating-audio',
        phase: 'loading',
        message: '正在生成语音...',
      });
    }
  }

  if (hasPreloadedAudio) {
    statusItems.push({
      key: 'story-preload-ready',
      phase: 'success',
      message: '故事预加载',
    });
  }

  if (statusItems.length === 0) {
    return null;
  }

  const iconForPhase: Record<Exclude<GenerationPhase, 'idle'>, React.FC<React.SVGProps<SVGSVGElement>>> = {
    loading: LoadingIcon,
    success: CheckIcon,
    error: WarningIcon,
  };

  return (
    <div className={containerClassName}>
      {statusItems.map((item) => {
        if (item.key === 'countdown') {
          return (
            <div key={item.key} className={`${styles.statusItem} ${styles.countdown}`}>
              <ClockIcon className={styles.statusIcon} />
              <span>{item.message}</span>
            </div>
          );
        }

        if (item.phase === 'idle' || !item.message) {
          return null;
        }

        const IconComponent = iconForPhase[item.phase] ?? CheckIcon;
        const phaseClass =
          item.phase === 'loading'
            ? styles.loading
            : item.phase === 'error'
              ? styles.error
              : styles.success;
        const iconClassName =
          item.phase === 'loading'
            ? `${styles.statusIcon} ${styles.loadingIcon}`
            : styles.statusIcon;

        return (
          <div key={item.key} className={`${styles.statusItem} ${phaseClass}`}>
            <IconComponent className={iconClassName} />
            <span>{item.message}</span>
          </div>
        );
      })}
    </div>
  );
};

export default PlaybackStatusBoard;
