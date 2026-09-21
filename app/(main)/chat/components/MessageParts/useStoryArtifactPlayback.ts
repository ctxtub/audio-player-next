'use client';

/**
 * 创作页作品卡播放 ViewModel（纯派生 + 动作委托）。
 *
 * 数据来源冻结：
 * - 当前卡片判定只看 `PlaybackSession.source.workId === artifact.storyWorkId`，
 *   不读最后一条消息、不做标题匹配；
 * - 播放状态只从 `PlaybackSessionStore + PlaybackStore` 派生，卡片本地不复制
 *   播放器状态（仅持有一个点击防重入的瞬时 busy 标记，不参与状态派生）；
 * - 进度只消费共享 Session/Transport 的秒级进度；duration 未知时不伪造百分比；
 * - 播放失败只落在对应卡片展示，不暴露内部错误码；
 * - 未形成 Work 的内容（draft/promoting/promotion_failed）不进入本 hook，
 *   由调用方保持原有生成/保存语义。
 *
 * 七态（`idle / preparing / playing / paused / error / expired / ended`）映射为
 * 纯函数 `deriveStoryArtifactPlaybackState`，Hook 层只做订阅与动作委托。
 * 缓存过期信号（`cache === 'missing'`）预留给正式音频投影接入；
 * 本段 Session 侧无可靠过期信号，运行时默认 `unknown`，不伪造过期态。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlaybackSessionStore, type PlaybackSessionStatus } from '@/stores/playbackSessionStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { pausePlayback, playStoryWork } from '@/app/services/playbackSessionFlow';
import { isValidWorkId, type PlaybackSourceRef } from '@/lib/playback/source';
import { getProjection } from '@/lib/client/storyAudio';

/** 作品卡播放七态。 */
export type StoryArtifactPlaybackState =
  | 'idle'
  | 'preparing'
  | 'playing'
  | 'paused'
  | 'error'
  | 'expired'
  | 'ended';

/** Session 快照输入（纯函数层，不直接读 store）。 */
export type StoryArtifactSessionSnapshot = {
  source: PlaybackSourceRef | null;
  status: PlaybackSessionStatus;
  nextParagraphIndex: number;
  totalParagraphs: number;
};

/** Transport 快照输入（纯函数层，不直接读 store）。 */
export type StoryArtifactTransportSnapshot = {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
};

/**
 * 音频缓存提示（正式音频投影接入点）。
 * `unknown` 为本段缺省：不猜测过期与否；`missing` 明确缺失时才进入 expired。
 */
export type StoryAudioCacheHint = 'unknown' | 'missing' | 'available';
type StoryAudioProjectionHint = 'unknown' | 'missing' | 'preparing' | 'ready' | 'failed' | 'expired';

/** 主操作图标语义（展示层据此选图标，不进业务分支）。 */
export type StoryArtifactPlaybackIcon = 'play' | 'pause' | 'retry' | 'restart' | 'loading';

/**
 * 当前卡片判定（唯一判定式）：
 * `PlaybackSession.source.workId === artifact.storyWorkId`。
 */
export function isCurrentStoryArtifactCard(
  source: PlaybackSourceRef | null,
  workId: number | null | undefined,
): boolean {
  if (!isValidWorkId(workId)) return false;
  return source !== null && source.kind === 'work' && source.workId === workId;
}

/**
 * 七态纯派生（无副作用，不读 store）。
 */
export function deriveStoryArtifactPlaybackState(input: {
  workId: number | null | undefined;
  session: StoryArtifactSessionSnapshot;
  transport: StoryArtifactTransportSnapshot;
  cache?: StoryAudioCacheHint;
  projection?: StoryAudioProjectionHint;
}): StoryArtifactPlaybackState {
  const { workId, session, transport, cache = 'unknown', projection = 'unknown' } = input;
  if (!isValidWorkId(workId)) return 'idle';
  if (!isCurrentStoryArtifactCard(session.source, workId)) {
    if (projection === 'preparing') return 'preparing';
    if (projection === 'failed') return 'error';
    if (projection === 'expired' || cache === 'missing') return 'expired';
    return 'idle';
  }
  if (session.status === 'error') return 'error';
  if (session.status === 'ended') return 'ended';
  if (session.status === 'synthesizing' || session.status === 'hydrating') return 'preparing';
  if (transport.isPlaying || session.status === 'playing') return 'playing';
  if (session.status === 'paused') return 'paused';
  if (session.status === 'ready') {
    if (projection === 'failed') return 'error';
    if (projection === 'expired' || cache === 'missing') return 'expired';
    return session.nextParagraphIndex > 0 ? 'paused' : 'idle';
  }
  return 'idle';
}

/** 秒级时钟文案（mm:ss，非法输入回退 00:00）。 */
export function formatPlaybackClock(totalSeconds: number): string {
  if (typeof totalSeconds !== 'number' || !Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '00:00';
  }
  const floored = Math.floor(totalSeconds);
  const minutes = Math.floor(floored / 60);
  const seconds = floored % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Transport 数值消毒（秒）。 */
function sanitizeClock(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 状态行文案纯派生（含 paused 的当前位置/总时长；duration 未知时只给位置）。
 */
export function deriveStoryArtifactStatusText(
  state: StoryArtifactPlaybackState,
  transport: StoryArtifactTransportSnapshot,
): string {
  switch (state) {
    case 'preparing':
      return '正在准备语音';
    case 'playing':
      return '正在播放';
    case 'paused': {
      const position = sanitizeClock(transport.currentTime);
      const duration = sanitizeClock(transport.duration);
      if (duration > 0) {
        return `已暂停 · ${formatPlaybackClock(position)} / ${formatPlaybackClock(duration)}`;
      }
      return `已暂停 · ${formatPlaybackClock(position)}`;
    }
    case 'error':
      return '语音准备失败';
    case 'expired':
      return '缓存已过期，将重新准备';
    case 'ended':
      return '播放完成';
    case 'idle':
    default:
      return '已保存';
  }
}

/** 主操作文案纯派生。 */
export function deriveStoryArtifactActionLabel(state: StoryArtifactPlaybackState): string {
  switch (state) {
    case 'preparing':
      return '正在准备语音';
    case 'playing':
      return '暂停';
    case 'paused':
      return '继续播放';
    case 'error':
      return '重试';
    case 'expired':
      return '重新准备';
    case 'ended':
      return '重新播放';
    case 'idle':
    default:
      return '播放';
  }
}

/** 主操作图标语义纯派生。 */
export function deriveStoryArtifactActionIcon(state: StoryArtifactPlaybackState): StoryArtifactPlaybackIcon {
  switch (state) {
    case 'preparing':
      return 'loading';
    case 'playing':
      return 'pause';
    case 'error':
    case 'expired':
      return 'retry';
    case 'ended':
      return 'restart';
    case 'paused':
    case 'idle':
    default:
      return 'play';
  }
}

/**
 * 进度纯派生（秒级共享进度；duration 未知时 ratio 为 null，不伪造百分比）。
 * 进度条只在 playing/paused 下填充；其余状态返回 null（轨道占位由展示层保持）。
 */
export function deriveStoryArtifactProgressRatio(
  state: StoryArtifactPlaybackState,
  transport: StoryArtifactTransportSnapshot,
): number | null {
  if (state !== 'playing' && state !== 'paused') return null;
  const duration = sanitizeClock(transport.duration);
  if (!(duration > 0)) return null;
  const current = sanitizeClock(transport.currentTime);
  return Math.min(1, Math.max(0, current / duration));
}

export type StoryArtifactPlaybackViewModel = {
  /** 七态。 */
  state: StoryArtifactPlaybackState;
  /** 是否为当前卡（source.workId 命中）。 */
  isCurrent: boolean;
  /** 主操作是否禁用（准备中或点击在途，防重复触发）。 */
  disabled: boolean;
  /** 状态行弱提示文案。 */
  statusText: string;
  /** 主操作文案。 */
  actionLabel: string;
  /** 主操作图标语义。 */
  actionIcon: StoryArtifactPlaybackIcon;
  /** 进度填充比（null 表示未知/不展示，不伪造）。 */
  progressRatio: number | null;
  /** 主操作：playing 走正式 pause，其余走正式 Work 播放（含重试/重播/续播）。 */
  runPrimary: () => void;
};

/**
 * Hook：订阅共享 Session/Transport，派生 ViewModel 并委托 Flow 动作。
 * 仅持有点击防重入的瞬时 busy 标记；播放语义状态一律来自 store 派生。
 */
export function useStoryArtifactPlaybackViewModel(
  workId: number | null | undefined,
  options?: { cache?: StoryAudioCacheHint; autoplayPending?: boolean },
): StoryArtifactPlaybackViewModel {
  const source = usePlaybackSessionStore((state) => state.source);
  const status = usePlaybackSessionStore((state) => state.status);
  const nextParagraphIndex = usePlaybackSessionStore((state) => state.nextParagraphIndex);
  const totalParagraphs = usePlaybackSessionStore((state) => state.totalParagraphs);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const duration = usePlaybackStore((state) => state.duration);

  const [acting, setActing] = useState(false);
  const [projection, setProjection] = useState<StoryAudioProjectionHint>('unknown');
  const actingRef = useRef(false);

  useEffect(() => {
    if (!isValidWorkId(workId)) {
      setProjection('unknown');
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        while (!cancelled) {
          const value = await getProjection({ workId });
          if (cancelled) return;
          if (value.status === 'missing' && value.readyAt !== null) {
            setProjection('expired');
            return;
          }
          setProjection(value.status);
          if (value.status !== 'preparing') return;
          await new Promise((resolve) => setTimeout(resolve, 750));
        }
      } catch {
        if (!cancelled) setProjection('unknown');
      }
    };
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [workId]);

  const cache = options?.cache ?? 'unknown';
  const session: StoryArtifactSessionSnapshot = {
    source,
    status,
    nextParagraphIndex,
    totalParagraphs,
  };
  const transport: StoryArtifactTransportSnapshot = { isPlaying, currentTime, duration };
  const state = options?.autoplayPending && isValidWorkId(workId)
    ? 'preparing'
    : deriveStoryArtifactPlaybackState({ workId, session, transport, cache, projection });
  const isCurrent = isCurrentStoryArtifactCard(source, workId);
  const disabled = state === 'preparing' || acting;

  const runPrimary = useCallback(() => {
    if (!isValidWorkId(workId)) return;
    if (state === 'preparing') return;
    if (state === 'playing') {
      pausePlayback();
      return;
    }
    if (actingRef.current) return;
    actingRef.current = true;
    setActing(true);
    void playStoryWork(workId)
      .catch(() => {
        // 失败态已由 Session 置 error 并落在对应卡片展示，此处不抛。
      })
      .finally(() => {
        actingRef.current = false;
        setActing(false);
      });
  }, [workId, state]);

  return {
    state,
    isCurrent,
    disabled,
    statusText: deriveStoryArtifactStatusText(state, transport),
    actionLabel: deriveStoryArtifactActionLabel(state),
    actionIcon: deriveStoryArtifactActionIcon(state),
    progressRatio: deriveStoryArtifactProgressRatio(state, transport),
    runPrimary,
  };
}
