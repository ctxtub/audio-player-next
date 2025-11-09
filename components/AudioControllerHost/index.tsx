'use client';

import React, { useCallback, useEffect, useRef } from 'react';
import { Toast } from 'antd-mobile';
import {
  handleNearEnd,
  handleSegmentEnded,
  handlePlaybackPause,
  handlePlaybackStart,
  updatePlaybackProgress,
} from '@/app/services/storyFlow';
import { usePlaybackStore } from '@/stores/playbackStore';
import type { AudioControllerHandle } from '@/types/audioPlayer';

/**
 * 静音音频资源（空 WAV），用于在 iOS 等平台解锁播放权限。
 */
const SILENT_AUDIO_DATA_URL =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=';

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
        console.error('解锁音频播放能力失败:', error);
        throw error instanceof Error ? error : new Error('音频播放解锁失败');
      } finally {
        audioEl.muted = previousState.muted;
        audioEl.volume = previousState.volume;
        audioEl.preload = previousState.preload;

        if (previousState.src) {
          audioEl.src = previousState.src;
          try {
            audioEl.currentTime = previousState.currentTime;
          } catch (seekError) {
            console.error('还原音频播放进度失败:', seekError);
          }
        } else {
          audioEl.removeAttribute('src');
          audioEl.load();
        }
        isUnlockingRef.current = false;
        if (shouldIgnoreNextEndedRef.current) {
          shouldIgnoreNextEndedRef.current = false;
        }
      }
    })();

    unlockPromiseRef.current = unlockPromise;

    try {
      await unlockPromise;
    } finally {
      unlockPromiseRef.current = null;
    }
  }, []);

  /**
   * 启动新音频播放，负责重置状态与触发播放开始回调。
   * @param audioUrl 音频文件地址
   * @returns Promise<void>
   */
  const handlePlay = useCallback(
    async (audioUrl: string) => {
      const audioEl = audioRef.current;
      if (!audioEl) {
        throw new Error('音频播放器尚未就绪');
      }
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
        Toast.show({ icon: 'fail', content: message, duration: 3000 });
        throw error instanceof Error ? error : new Error(message);
      }
    },
    [playbackRate]
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
      Toast.show({ icon: 'fail', content: message, duration: 3000 });
      throw error instanceof Error ? error : new Error(message);
    }
  }, []);

  /**
   * 暂停当前播放并同步全局状态。
   */
  const handlePause = useCallback(() => {
    const audioEl = audioRef.current;
    if (!audioEl) {
      return;
    }
    audioEl.pause();
    handlePlaybackPause();
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
        if (!hasTriggeredPreload.current && remaining <= 120) {
          hasTriggeredPreload.current = true;
          handleNearEnd().catch((error) => {
            console.error('预加载下一段音频失败:', error);
          });
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
        const nextSegment = await handleSegmentEnded();
        if (!nextSegment) {
          return;
        }
        await handlePlay(nextSegment.audioUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法播放下一段音频';
        Toast.show({ icon: 'fail', content: message, duration: 3000 });
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
