import React, { useMemo } from 'react';
import ClockIcon from '@/public/icons/playstatus-clock.svg';
import LoadingIcon from '@/public/icons/playstatus-loading.svg';
import WarningIcon from '@/public/icons/playstatus-warning.svg';
import CheckIcon from '@/public/icons/playstatus-check.svg';
import { useStoryStore } from '@/stores/storyStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { usePreloadStore } from '@/stores/preloadStore';
import { useConfigStore } from '@/stores/configStore';
import { cx } from '@/utils/cx';

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
  /** 故事文本列表，用于判断首段生成是否完成。 */
  const storySegments = useStoryStore((state) => state.segments);
  /** 当前故事会话标识，判定是否已有会话。 */
  const storySessionId = useStoryStore((state) => state.sessionId);

  /** 播放剩余毫秒数，用于倒计时展示。 */
  const playbackRemainingMs = usePlaybackStore((state) => state.remainingMs);
  /** 播放会话标识，结合故事会话判断首段进度。 */
  const playbackSessionId = usePlaybackStore((state) => state.sessionId);

  /** 当前配置项，提供默认播放时长。 */
  const apiConfig = useConfigStore((state) => state.apiConfig);

  /** 预加载流程状态，判断语音生成阶段。 */
  const preloadStatus = usePreloadStore((state) => state.status);
  /** 预加载重试次数，用于提示重试进度。 */
  const preloadRetryCount = usePreloadStore((state) => state.retryCount);
  /** 已缓存的语音地址，提示资源可用。 */
  const preloadAudioUrl = usePreloadStore((state) => state.cachedAudioUrl);

  const remainingTime = useMemo(() => {
    if (playbackRemainingMs === null) {
      return apiConfig.playDuration > 0 ? apiConfig.playDuration : null;
    }
    return Math.max(0, playbackRemainingMs / 60000);
  }, [apiConfig.playDuration, playbackRemainingMs]);

  /** 是否仍有首段故事文本或音频待生成。 */
  const hasPendingInitialRequest =
    Boolean(storySessionId) &&
    (storySegments.length === 0 || playbackSessionId !== storySessionId);
  /** 故事生成流程是否处于进行状态（文本或音频请求）。 */
  const isStoryLoading = hasPendingInitialRequest || preloadStatus === 'loading';
  /** 是否已有已缓存的语音资源，可提示预加载成功。 */
  const hasPreloadedAudio = Boolean(preloadAudioUrl);

  const containerClassName = cx('flex flex-wrap gap-3', className);

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
      message: `播放倒计时: ${formatCountdown(remainingTime)}`,
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
            <div
              key={item.key}
              className="flex min-w-[172px] items-center gap-2 rounded-[12px] bg-[color-mix(in_srgb,var(--process)_20%,transparent)] px-[14px] py-[10px] text-sm font-medium text-[var(--process)] shadow-[0_2px_8px_var(--shadow-color)] backdrop-blur-[5px] transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)] hover:-translate-y-px"
            >
              <ClockIcon className="h-4 w-4 text-current" />
              <span>{item.message}</span>
            </div>
          );
        }

        if (item.phase === 'idle' || !item.message) {
          return null;
        }

        const IconComponent = iconForPhase[item.phase] ?? CheckIcon;
        const phaseClass = cx(
          'flex min-w-[172px] items-center gap-2 rounded-[12px] px-[14px] py-[10px] text-sm font-medium shadow-[0_2px_8px_var(--shadow-color)] backdrop-blur-[5px] transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)] hover:-translate-y-px',
          item.phase === 'loading'
            ? 'bg-[color-mix(in_srgb,var(--process)_20%,transparent)] text-[var(--process)]'
            : item.phase === 'error'
              ? 'bg-[color-mix(in_srgb,var(--error)_20%,transparent)] text-[var(--error)]'
              : 'bg-[color-mix(in_srgb,var(--success)_20%,transparent)] text-[var(--success)]'
        );
        const iconClassName = cx(
          'h-4 w-4 text-current',
          item.phase === 'loading' && 'animate-spin'
        );

        return (
          <div key={item.key} className={phaseClass}>
            <IconComponent className={iconClassName} />
            <span>{item.message}</span>
          </div>
        );
      })}
    </div>
  );
};

export default PlaybackStatusBoard;
