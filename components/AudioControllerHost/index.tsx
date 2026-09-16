'use client';

import React, { useCallback, useEffect, useRef } from 'react';
import GlassToast from '@/components/ui/GlassToast';
/**
 * M5-09 §26.1：Host 只报告 Audio events，领域决策下沉 PlaybackSessionFlow。
 * 不再直接 import storyFlow / ChatStore / PreloadStore / PlaybackProgressStore
 *（chat/work/generation/AI 续写一律由 flow 决定，M9 删除 transitional fallback）。
 */
import {
  handleEnded as handleSessionEnded,
  pausePlayback as pauseViaSessionFlow,
  registerSleepTimerExpiryHandler,
  reportAudioActive,
  reportPlaybackPause,
  reportPlaybackStart,
  reportProgress,
  reportTimeUpdate,
} from '@/app/services/playbackSessionFlow';
import { usePlaybackStore } from '@/stores/playbackStore';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import { createAudioEndedGuard } from '@/utils/audioEndedGuard';
import type { AudioControllerHandle } from '@/types/audioPlayer';

/**
 * 静音音频资源（空 WAV），用于在 iOS 等平台解锁播放权限。
 */
const SILENT_AUDIO_DATA_URL =
  'data:audio/wav;base64,UklGRl4RAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YToRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/**
 * 判断播放请求因暂停而被中断的异常类型，避免重复弹出错误提示。
 * @param error 未处理的异常对象
 * @returns 是否属于暂停触发的中断错误
 */
const isPlayInterruptedError = (error: unknown): boolean => {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    if (error.name === 'AbortError' || error.code === 20) {
      return true;
    }
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('play() request was interrupted') && message.includes('pause')) {
      return true;
    }
  }
  return false;
};

/**
 * 全局音频控制宿主组件，挂载隐藏的 audio 元素并向 Store 注册控制器。
 * @returns 隐藏的音频标签
 */
const AudioControllerHost: React.FC = () => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hasTriggeredPreload = useRef(false);
  const unlockPromiseRef = useRef<Promise<void> | null>(null);
  const isUnlockedRef = useRef(false);
  /**
   * 标记当前是否处于解锁流程，避免事件监听器误触发业务逻辑。
   */
  const isUnlockingRef = useRef(false);
  /**
   * 解锁静音片段的 ended 守卫（R15：settled 清标记，防吞首个真实 ended）。
   */
  const endedGuardRef = useRef(createAudioEndedGuard());
  const playbackRate = usePlaybackStore((state) => state.playbackRate);
  const registerAudioController = usePlaybackStore((state) => state.registerAudioController);

  /**
   * 解锁音频播放能力，避免移动端受限于未授权的用户手势。
   * @returns Promise<void>
   */
  const handleUnlock = useCallback(async () => {
    if (isUnlockedRef.current) {
      return;
    }
    if (unlockPromiseRef.current) {
      await unlockPromiseRef.current;
      return;
    }

    const audioEl = audioRef.current;
    if (!audioEl) {
      throw new Error('音频播放器尚未就绪');
    }

    const previousState = {
      src: audioEl.src,
      currentTime: audioEl.currentTime,
      preload: audioEl.preload,
      muted: audioEl.muted,
      volume: audioEl.volume,
    };

    const unlockPromise = (async () => {
      isUnlockingRef.current = true;
      endedGuardRef.current.armForUnlock();
      audioEl.muted = true;
      audioEl.volume = 0;
      audioEl.preload = 'auto';
      audioEl.src = SILENT_AUDIO_DATA_URL;
      audioEl.currentTime = 0;

      try {
        await audioEl.play();
        audioEl.pause();
        isUnlockedRef.current = true;
      } catch (error) {
        console.warn('音频解锁失败，将在播放时重试:', error);
      } finally {
        audioEl.src = previousState.src;
        audioEl.currentTime = previousState.currentTime;
        audioEl.preload = previousState.preload;
        audioEl.muted = previousState.muted;
        audioEl.volume = previousState.volume;
        isUnlockingRef.current = false;
        // 中文注释：R15——静音片段经 pause 收尾永不触发 ended，settled 即清标记。
        endedGuardRef.current.settleUnlock();
        unlockPromiseRef.current = null;
      }
    })();

    unlockPromiseRef.current = unlockPromise;
    await unlockPromise;
  }, []);

  /**
   * 播放指定音频资源。
   * @param audioUrl 音频地址
   * @param messageId 关联消息 ID
   * @returns Promise<void>
   */
  const handlePlay = useCallback(
    async (audioUrl: string, messageId?: string) => {
      const audioEl = audioRef.current;
      if (!audioEl) {
        throw new Error('音频播放器尚未就绪');
      }

      await handleUnlock();

      // M5-09：Host 不再做 Preload/Chat 领域判断（§26.1）。
      // 预载锁与最新消息匹配由 PlaybackSessionFlow 统一决策，此处只做 transport 同步。
      // 同步当前播放地址到 Store，确保 StoryCard UI 状态正确
      // 使用 syncPlaybackState 避免递归调用 play
      usePlaybackStore.getState().syncPlaybackState(audioUrl, messageId);

      audioEl.src = audioUrl;
      audioEl.currentTime = 0;
      audioEl.playbackRate = playbackRate;
      hasTriggeredPreload.current = false;
      reportProgress({ currentTime: 0, duration: 0 });
      try {
        await audioEl.play();
        reportPlaybackStart();
      } catch (error) {
        if (isPlayInterruptedError(error)) {
          return;
        }
        reportPlaybackPause();
        const message = error instanceof Error ? error.message : '无法播放音频';
        GlassToast.show({ icon: 'fail', content: message, duration: 3000 });
        throw error instanceof Error ? error : new Error(message);
      }
    },
    [handleUnlock, playbackRate]
  );

  /**
   * 恢复暂停的音频播放。
   * @returns Promise<void>
   */
  const handleResume = useCallback(async () => {
    const audioEl = audioRef.current;
    if (!audioEl) {
      throw new Error('音频播放器尚未就绪');
    }
    try {
      await audioEl.play();
      reportPlaybackStart();
    } catch (error) {
      if (isPlayInterruptedError(error)) {
        return;
      }
      reportPlaybackPause();
      const message = error instanceof Error ? error.message : '无法恢复播放';
      GlassToast.show({ icon: 'fail', content: message, duration: 3000 });
      throw error instanceof Error ? error : new Error(message);
    }
  }, []);

  /**
   * 暂停当前播放并同步全局状态与断点（经 SessionFlow，不触 Chat/Work 领域）。
   */
  const handlePause = useCallback(() => {
    const audioEl = audioRef.current;
    if (!audioEl) {
      return;
    }
    audioEl.pause();
    pauseViaSessionFlow();
  }, []);

  /**
   * 调整播放进度到指定时间点。
   * @param time 目标秒数
   */
  const handleSeek = useCallback((time: number) => {
    const audioEl = audioRef.current;
    if (!audioEl) {
      return;
    }
    audioEl.currentTime = time;
    const duration = Number.isFinite(audioEl.duration) ? audioEl.duration : 0;
    reportProgress({ currentTime: time, duration });
  }, []);

  /**
   * 设置音频播放速率。
   * @param rate 目标倍速
   */
  const handleSetPlaybackRate = useCallback((rate: number) => {
    const audioEl = audioRef.current;
    if (audioEl) {
      audioEl.playbackRate = rate;
    }
  }, []);

  useEffect(() => {
    const controller: AudioControllerHandle = {
      unlock: handleUnlock,
      play: handlePlay,
      resume: handleResume,
      pause: handlePause,
      seek: handleSeek,
      setPlaybackRate: handleSetPlaybackRate,
    };
    registerAudioController(controller);
    // M7-03：Transport 到期回调注册（pause audio 后经 Flow 做 checkpoint + Toast，§26）。
    registerSleepTimerExpiryHandler();
    return () => {
      registerAudioController(null);
    };
  }, [
    handlePause,
    handlePlay,
    handleResume,
    handleSeek,
    handleSetPlaybackRate,
    handleUnlock,
    registerAudioController,
  ]);

  useEffect(() => {
    // T3 单轨：页面隐藏/离开时强制落库当前作品 positionMs（force 绕过客户端节流；
    // server clamp/单调/节流二次保证不变）。AudioControllerHost 为主区唯一全局挂载点。
    const flushSingleTrackProgress = () => {
      void usePlaybackSessionStore.getState().persistSingleTrackProgress({ force: true });
    };
    const handleVisibilityChange = () => {
      if (document.hidden) flushSingleTrackProgress();
    };
    const handlePageHide = () => flushSingleTrackProgress();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('beforeunload', handlePageHide);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('beforeunload', handlePageHide);
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  useEffect(() => {
    const audioEl = audioRef.current;
    if (!audioEl) {
      return;
    }

    const handleTimeUpdate = () => {
      if (isUnlockingRef.current) {
        return;
      }
      const currentTime = audioEl.currentTime;
      const duration = Number.isFinite(audioEl.duration) ? audioEl.duration : 0;
      // M5-09：near-end / 预载决策下沉 flow，Host 只上报 timeupdate。
      reportTimeUpdate({ currentTime, duration, hasTriggeredPreload });
    };

    const handleLoadedMetadata = () => {
      if (isUnlockingRef.current) {
        return;
      }
      hasTriggeredPreload.current = false;
      const duration = Number.isFinite(audioEl.duration) ? audioEl.duration : 0;
      reportProgress({ currentTime: 0, duration });
    };

    const handleEnded = async () => {
      // 中文注释：仅跳过解锁窗口内置位的静音片段 ended（命中即消费一次）。
      if (endedGuardRef.current.shouldSkipEnded()) {
        return;
      }
      // M5-09：segment / continuation / checkpoint 由 flow 决定，Host 只报告 ended。
      reportPlaybackPause();
      reportAudioActive(false);
      try {
        await handleSessionEnded(handlePlay);
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法播放下一段音频';
        GlassToast.show({ icon: 'fail', content: message, duration: 3000 });
      }
    };

    // M7-03 fixup（复审 Blocking 1 / §25.1）：buffering 生命周期 → Transport.audioActive。
    // playing（实际推进中）→ true；waiting/stalled（网络等待）→ false；pause → false。
    // 仅用于 sleep timer countdown 门；不映射为 Session 语义状态（waiting ≠ 用户暂停）。
    const handleAudioPlaying = () => {
      reportAudioActive(true);
    };

    const handleAudioInactive = () => {
      reportAudioActive(false);
    };

    audioEl.addEventListener('timeupdate', handleTimeUpdate);
    audioEl.addEventListener('loadedmetadata', handleLoadedMetadata);
    audioEl.addEventListener('ended', handleEnded);
    audioEl.addEventListener('playing', handleAudioPlaying);
    audioEl.addEventListener('waiting', handleAudioInactive);
    audioEl.addEventListener('stalled', handleAudioInactive);
    audioEl.addEventListener('pause', handleAudioInactive);

    return () => {
      audioEl.removeEventListener('timeupdate', handleTimeUpdate);
      audioEl.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audioEl.removeEventListener('ended', handleEnded);
      audioEl.removeEventListener('playing', handleAudioPlaying);
      audioEl.removeEventListener('waiting', handleAudioInactive);
      audioEl.removeEventListener('stalled', handleAudioInactive);
      audioEl.removeEventListener('pause', handleAudioInactive);
    };
  }, [handlePlay]);

  return <audio ref={audioRef} style={{ display: 'none' }} />;
};

export default AudioControllerHost;
