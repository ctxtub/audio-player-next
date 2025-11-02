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
 * 全局音频控制宿主组件，挂载隐藏的 audio 元素并向 Store 注册控制器。
 * @returns 隐藏的音频标签
 */
const AudioControllerHost: React.FC = () => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hasTriggeredPreload = useRef(false);
  const playbackRate = usePlaybackStore((state) => state.playbackRate);
  const registerAudioController = usePlaybackStore((state) => state.registerAudioController);

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
  }, [handlePause, handlePlay, handleResume, handleSeek, handleSetPlaybackRate, registerAudioController]);

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
      hasTriggeredPreload.current = false;
      const duration = Number.isFinite(audioEl.duration) ? audioEl.duration : 0;
      updatePlaybackProgress({ currentTime: 0, duration });
    };

    const handleEnded = async () => {
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
