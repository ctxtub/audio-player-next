import React, { useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Toast } from 'antd-mobile';
import { AudioPlayer, AudioPlayerHandle } from './components/AudioPlayer';
import InputStatusSection from './components/InputStatusSection';
import StoryViewer from './components/StoryViewer';
import { PageLoading } from '@/components/PageLoading';
import styles from './index.module.scss';

import { useConfigStore } from '@/stores/configStore';
import { useStoryStore } from '@/stores/storyStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { usePreloadStore } from '@/stores/preloadStore';
import {
  beginStorySession,
  handleNearEnd,
  handleSegmentEnded,
  handlePlaybackPause,
  handlePlaybackStart,
  resetStoryFlow,
  updatePlaybackProgress,
} from '@/app/services/storyFlow';

/**
 * 首页页面组件，负责串联故事生成与音频播放交互。
 * @returns 首页 JSX 结构
 */
const HomePage: React.FC = () => {
  const router = useRouter();

  // 统一管理 apiConfig 状态
  const apiConfig = useConfigStore(state => state.apiConfig);
  const initializeConfig = useConfigStore(state => state.initialize);
  const isConfigLoaded = useConfigStore(state => state.isLoaded);
  const configIsValid = useConfigStore(state => state.isConfigValid());

  useEffect(() => {
    initializeConfig().catch(() => {});
  }, [initializeConfig]);

  useEffect(() => {
    if (!isConfigLoaded) {
      return;
    }
    if (!configIsValid) {
      router.push('/config');
    }
  }, [isConfigLoaded, configIsValid, router]);

  // 故事状态
  const storyInputText = useStoryStore((state) => state.inputText);
  const storySegments = useStoryStore((state) => state.segments);
  const storyIsFirstLoading = useStoryStore((state) => state.isFirstStoryLoading);

  // 播放器状态
  const playbackRemainingMs = usePlaybackStore((state) => state.remainingMs);

  // 预加载状态
  const preloadStatus = usePreloadStore((state) => state.status);
  const preloadRetryCount = usePreloadStore((state) => state.retryCount);
  const preloadErrorMsg = usePreloadStore((state) => state.error);
  const preloadAudioUrl = usePreloadStore((state) => state.cachedAudioUrl);

  const audioRef = useRef<AudioPlayerHandle>(null);

  useEffect(() => {
    return () => {
      resetStoryFlow();
    };
  }, []);

  const remainingMinutes =
    playbackRemainingMs === null ? null : Math.max(0, playbackRemainingMs / 60000);

  // 输入框模块：提交生成故事请求
  const handleInputSubmit = useCallback(
    async (shortcutText: string) => {
      try {
        if (audioRef.current) {
          audioRef.current.pause();
        }

        const { audioUrl } = await beginStorySession(shortcutText);

        if (!audioRef.current) {
          throw new Error('播放器尚未就绪');
        }

        await audioRef.current.play(audioUrl);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '发生未知错误';
        Toast.show({ icon: 'fail', content: errorMessage, duration: 3000 });
        resetStoryFlow();
      }
    },
    []
  );

  // 播放控制模块：播放器播放/暂停回调
  const handlePlayCallback = useCallback(() => {
    handlePlaybackStart();
  }, []);

  const handlePauseCallback = useCallback(() => {
    handlePlaybackPause();
  }, []);

  // 播放控制模块：音频播放结束时处理
  const handleAudioEndedCallback = useCallback(async () => {
    try {
      const nextSegment = await handleSegmentEnded();
      if (!nextSegment) {
        return;
      }

      if (!audioRef.current) {
        throw new Error('播放器尚未就绪');
      }

      await audioRef.current.play(nextSegment.audioUrl);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '无法播放下一段音频';
      Toast.show({ icon: 'fail', content: errorMessage, duration: 3000 });
      handlePauseCallback();
    }
  }, [handlePauseCallback]);

  // 播放控制模块：音频即将结束时触发预加载
  const handleNearEndCallback = useCallback(() => {
    handleNearEnd();
  }, []);

  const handleProgressUpdate = useCallback((payload: { currentTime: number; duration: number }) => {
    updatePlaybackProgress(payload);
  }, []);

  if (!isConfigLoaded) {
    return <PageLoading message="页面加载中..." />;
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageSection}>
        <InputStatusSection
          // StoryInput props
          inputText={storyInputText}
          isFirstStoryLoading={storyIsFirstLoading}
          handleSubmit={handleInputSubmit}
          
          // PlayStatusSection props
          remainingTime={remainingMinutes === null ? apiConfig.playDuration : remainingMinutes}
          isPreloadLoading={preloadStatus === 'loading'}
          preloadRetryCount={preloadRetryCount}
          preloadErrorMsg={preloadErrorMsg || ''}
          preloadAudioUrl={preloadAudioUrl}
        />

        <AudioPlayer
          ref={audioRef}
          onPlay={handlePlayCallback}
          onPause={handlePauseCallback}
          onEnded={handleAudioEndedCallback}
          onNearEnd={handleNearEndCallback}
          onProgress={handleProgressUpdate}
        />

        <StoryViewer
          storyList={storySegments}
        />
      </div>
    </div>
  );
};

export default HomePage;
