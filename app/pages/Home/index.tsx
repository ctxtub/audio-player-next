import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AudioPlayer, AudioPlayerHandle } from '../../../components/AudioPlayer';
import InputStatusSection from '../../../components/InputStatusSection';
import StoryViewer from '../../../components/StoryViewer';
import { Toast } from '../../../components/Toast';
import { useTheme } from '../../../components/ThemeProvider';
import { trackEvent } from '../../utils/analytics';
import styles from './index.module.scss';
// 只导入用户信息相关接口
import { fetchUserInfo, UserInfo } from '../../api/user';
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
import { PageLoading } from '@/components/PageLoading';

const HomePage: React.FC = () => {
  const { theme, toggleTheme } = useTheme();
  const router = useRouter();

  // 添加用户信息状态
  const [userState, setUserState] = useState<{
    userInfo: UserInfo | null;
    isLoading: boolean;
    error: string | null;
  }>({
    userInfo: null,
    isLoading: false,
    error: null,
  });

  // 统一管理 apiConfig 状态
  const apiConfig = useConfigStore(state => state.apiConfig);
  const hydrateConfig = useConfigStore(state => state.hydrateFromStorage);
  const isConfigLoaded = useConfigStore(state => state.isLoaded);
  const configIsValid = useConfigStore(state => state.isConfigValid());
  const configLoadError = useConfigStore(state => state.loadError);
  const applyUserPreferences = useConfigStore(state => state.applyUserPreferences);

  useEffect(() => {
    hydrateConfig();
  }, [hydrateConfig]);

  useEffect(() => {
    if (!isConfigLoaded) {
      return;
    }
    if (!configIsValid) {
      router.push('/config');
    }
  }, [isConfigLoaded, configIsValid, router]);

  useEffect(() => {
    if (configLoadError) {
      Toast({ message: '配置加载失败，已恢复默认设置' });
    }
  }, [configLoadError]);

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

  // 添加获取用户信息的函数
  const getUserInfo = async () => {
    try {
      setUserState(prev => ({ ...prev, isLoading: true, error: null }));
      
      // 直接调用接口，不需要关心是否使用模拟数据
      const userInfo = await fetchUserInfo();
      
      setUserState(prev => ({ ...prev, userInfo, isLoading: false }));
      
      // 如果用户有偏好设置，更新应用配置
      if (userInfo.preferences) {
        // 更新主题
        if (userInfo.preferences.theme && theme !== userInfo.preferences.theme) {
          toggleTheme();
        }
        
        // 更新播放时长
        if (userInfo.preferences.playDuration && userInfo.preferences.playDuration !== apiConfig.playDuration) {
          applyUserPreferences({ playDuration: userInfo.preferences.playDuration });
        }
      }
      
      trackEvent('user_info_loaded', 'user', userInfo.username);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '获取用户信息失败';
      setUserState(prev => ({ ...prev, isLoading: false, error: errorMessage }));
      Toast({ message: errorMessage });
      trackEvent('user_info_error', 'error', errorMessage);
    }
  };

  // 组件挂载时获取用户信息
  useEffect(() => {
    getUserInfo();
  }, []);

  useEffect(() => {
    return () => {
      resetStoryFlow();
    };
  }, []);

  const remainingMinutes =
    playbackRemainingMs === null ? null : Math.max(0, playbackRemainingMs / 60_000);

  // 输入框模块：提交生成故事请求
  const handleInputSubmit = useCallback(
    async (shortcutText: string) => {
      if (!apiConfig.apiKey) {
        Toast({ message: '请先配置API密钥' });
        router.push('/config');
        trackEvent('config_required', 'error', 'missing_api_key');
        return;
      }

      try {
        if (audioRef.current) {
          audioRef.current.pause();
        }

        trackEvent('generate_story', 'story', shortcutText);
        const { audioUrl, segment } = await beginStorySession(shortcutText);
        trackEvent('story_generated', 'story_success', shortcutText, segment.length);

        if (!audioRef.current) {
          throw new Error('播放器尚未就绪');
        }

        await audioRef.current.play(audioUrl);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '发生未知错误';
        Toast({ message: errorMessage });
        trackEvent('generation_error', 'error', errorMessage);
        resetStoryFlow();
      }
    },
    [apiConfig.apiKey, router]
  );

  // 播放控制模块：音频播放结束时处理
  const handleAudioEndedCallback = useCallback(async () => {
    try {
      trackEvent('audio_completed', 'playback');
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
      Toast({ message: errorMessage });
      trackEvent('playback_error', 'error', errorMessage);
      handlePlaybackPause();
    }
  }, [handlePlaybackPause]);

  // 播放控制模块：音频即将结束时触发预加载
  const handleNearEndCallback = useCallback(() => {
    handleNearEnd();
  }, []);

  // 播放控制模块：播放器播放/暂停回调
  const handlePlayCallback = useCallback(() => {
    handlePlaybackStart();
    trackEvent('audio_play', 'playback');
  }, []);

  const handlePauseCallback = useCallback(() => {
    handlePlaybackPause();
    trackEvent('audio_pause', 'playback');
  }, []);

  const handleProgressUpdate = useCallback((payload: { currentTime: number; duration: number }) => {
    updatePlaybackProgress(payload);
  }, []);

  // 添加刷新用户信息的函数
  const handleRefreshUserInfo = () => {
    getUserInfo();
    Toast({ message: '用户信息已刷新' });
  };

  if (!isConfigLoaded) {
    return <PageLoading message="加载配置中..." />;
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h1>AI故事播放器</h1>
        <div className={styles.headerRight}>
          {/* 添加用户信息显示 */}
          {userState.userInfo && (
            <div className={styles.userInfo}>
              <div className={styles.userAvatar} onClick={handleRefreshUserInfo}>
                {userState.userInfo.avatar ? (
                  <img src={userState.userInfo.avatar} alt="用户头像" />
                ) : (
                  <span>{userState.userInfo.nickname?.[0] || userState.userInfo.username[0]}</span>
                )}
              </div>
              <div className={styles.userName}>
                {userState.userInfo.nickname || userState.userInfo.username}
              </div>
            </div>
          )}
          <button
            className={styles.themeButton}
            onClick={toggleTheme}
            aria-label="切换主题"
          >
            {theme === 'dark' ? '🌞' : '🌙'}
          </button>
          <button
            className={styles.settingsButton}
            onClick={() => router.push('/config')}
            aria-label="设置"
          >
            ⚙️
          </button>
        </div>
      </div>

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
