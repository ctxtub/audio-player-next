'use client';

import React, { useCallback, useEffect, useRef } from 'react';
import GlassToast from '@/components/ui/GlassToast';
import {
  handleNearEnd,
  handleSegmentEnded,
  handlePlaybackPause,
  handlePlaybackStart,
  updatePlaybackProgress,
} from '@/app/services/storyFlow';
import { usePlaybackStore } from '@/stores/playbackStore';
import { usePlaybackProgressStore } from '@/stores/playbackProgressStore';
import { usePreloadStore } from '@/stores/preloadStore';
import { useChatStore } from '@/stores/chatStore';
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
   * 标记是否需要忽略下一次 ended 事件（解锁使用的静音片段）。
   */
  const shouldIgnoreNextEndedRef = useRef(false);
  const isTransitioningRef = useRef(false);
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
      shouldIgnoreNextEndedRef.current = true;
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

      // 若播放的是最新预加载的段落，需重置 PreloadStore 状态，
      // 防止后续逻辑误判导致跳过下一次预加载。
      const preloadStore = usePreloadStore.getState();
      // 使用 messageId 进行精准匹配
      if (messageId && useChatStore.getState().selectors.isLatestMessage(messageId)) {
        if (preloadStore.status === 'ready') {
          preloadStore.consume();
        }
      }

      // 同步当前播放地址到 Store，确保 StoryCard UI 状态正确
      // 使用 syncPlaybackState 避免递归调用 play
      usePlaybackStore.getState().syncPlaybackState(audioUrl, messageId);

      audioEl.src = audioUrl;
      audioEl.currentTime = 0;
      audioEl.playbackRate = playbackRate;
      hasTriggeredPreload.current = false;
      updatePlaybackProgress({ currentTime: 0, duration: 0 });
      try {
        await audioEl.play();
        handlePlaybackStart();
      } catch (error) {
        if (isPlayInterruptedError(error)) {
          return;
        }
        handlePlaybackPause();
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
      handlePlaybackStart();
    } catch (error) {
      if (isPlayInterruptedError(error)) {
        return;
      }
      handlePlaybackPause();
      const message = error instanceof Error ? error.message : '无法恢复播放';
      GlassToast.show({ icon: 'fail', content: message, duration: 3000 });
      throw error instanceof Error ? error : new Error(message);
    }
  }, []);

  /**
   * 暂停当前播放并同步全局状态与断点。
   */
  const handlePause = useCallback(() => {
    const audioEl = audioRef.current;
    if (!audioEl) {
      return;
    }
    audioEl.pause();
    handlePlaybackPause();
    usePlaybackProgressStore.getState().handleExplicitPause();
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
    updatePlaybackProgress({ currentTime: time, duration });
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
      updatePlaybackProgress({ currentTime, duration });
      if (duration > 0) {
        const remaining = duration - currentTime;
        const adaptiveThreshold = Math.min(10, Math.max(5, duration * 0.25));

        // 仅在自适应窗口内触发预加载，且严格仅在播放态中触发（暂停态严禁预加载）
        if (!hasTriggeredPreload.current && remaining <= adaptiveThreshold) {
          const isPlaying = usePlaybackStore.getState().isPlaying;
          if (!isPlaying) {
            return;
          }

          const progressState = usePlaybackProgressStore.getState();
          // 若当前为多自然段故事且存在下一段：触发自然段预加载（严格单一前瞻 lookahead = 1）
          if (
            progressState.sourceId &&
            progressState.totalParagraphs > 1 &&
            progressState.nextParagraphIndex + 1 < progressState.totalParagraphs
          ) {
            hasTriggeredPreload.current = true;
            progressState.prefetchNextParagraph(progressState.nextParagraphIndex + 1);
          } else {
            // 聊天续写模式预加载
            const currentMessageId = usePlaybackStore.getState().currentMessageId;
            const isLast = currentMessageId
              ? useChatStore.getState().selectors.isLatestMessage(currentMessageId)
              : false;

            if (isLast && !usePlaybackStore.getState().isOneShot) {
              hasTriggeredPreload.current = true;
              handleNearEnd().catch((error) => {
                console.error('预加载下一段音频失败:', error);
              });
            }
          }
        }
      }
    };

    const handleLoadedMetadata = () => {
      if (isUnlockingRef.current) {
        return;
      }
      hasTriggeredPreload.current = false;
      const duration = Number.isFinite(audioEl.duration) ? audioEl.duration : 0;
      updatePlaybackProgress({ currentTime: 0, duration });
    };

    const handleEnded = async () => {
      if (shouldIgnoreNextEndedRef.current) {
        shouldIgnoreNextEndedRef.current = false;
        return;
      }
      handlePlaybackPause();
      try {
        const progressStore = usePlaybackProgressStore.getState();
        // 优先检查当前多段故事是否包含未播自然段
        if (
          progressStore.sourceId &&
          progressStore.totalParagraphs > 1 &&
          progressStore.nextParagraphIndex + 1 < progressStore.totalParagraphs
        ) {
          isTransitioningRef.current = true;
          await progressStore.handleParagraphEnded();
          isTransitioningRef.current = false;
          return;
        }

        // 当前故事所有自然段播毕：主动注销断点
        if (progressStore.sourceId && progressStore.totalParagraphs > 0) {
          await progressStore.clearProgress();
        }

        const nextSegment = await handleSegmentEnded();
        if (!nextSegment) {
          return;
        }
        await handlePlay(nextSegment.audioUrl, nextSegment.messageId);
      } catch (error) {
        isTransitioningRef.current = false;
        const message = error instanceof Error ? error.message : '无法播放下一段音频';
        GlassToast.show({ icon: 'fail', content: message, duration: 3000 });
      }
    };

    audioEl.addEventListener('timeupdate', handleTimeUpdate);
    audioEl.addEventListener('loadedmetadata', handleLoadedMetadata);
    audioEl.addEventListener('ended', handleEnded);

    return () => {
      audioEl.removeEventListener('timeupdate', handleTimeUpdate);
      audioEl.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audioEl.removeEventListener('ended', handleEnded);
    };
  }, [handlePlay]);

  return <audio ref={audioRef} style={{ display: 'none' }} />;
};

export default AudioControllerHost;
