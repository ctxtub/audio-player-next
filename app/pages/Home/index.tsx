import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { fetchAudio, generateStory, continueStory } from '../../api/chat';
import { AudioPlayer, AudioPlayerHandle } from '../../../components/AudioPlayer';
import InputStatusSection from '../../../components/InputStatusSection';
import StoryViewer from '../../../components/StoryViewer';
import { Toast } from '../../../components/Toast';
import { useTheme } from '../../../components/ThemeProvider';
import { trackEvent } from '../../utils/analytics';
import { DEFAULT_API_CONFIG, CURRENT_CONFIG_VERSION, isValidConfig } from '../../config/home';
import { APIConfig } from '@/types/types';
import styles from './index.module.scss';
// 只导入用户信息相关接口
import { fetchUserInfo, UserInfo } from '../../api/user';

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

  // 初始化 apiConfig 状态
  const [apiConfig, setApiConfig] = useState<APIConfig>(() => {
    try {
      const savedConfig = localStorage.getItem('apiConfig');
      if (savedConfig) {
        const config = JSON.parse(savedConfig);
        if (config.version === CURRENT_CONFIG_VERSION && isValidConfig(config)) {
          return config;
        }
        localStorage.removeItem('apiConfig');
      }
      // 如果没有有效配置，则存入默认配置
      localStorage.setItem('apiConfig', JSON.stringify(DEFAULT_API_CONFIG));
    } catch (error) {
      console.error('Error loading config:', error);
    }
    return DEFAULT_API_CONFIG;
  });

  // 修改 showConfigForm 状态
  const [shouldRedirectToConfig, setShouldRedirectToConfig] = useState(() => {
    try {
      const savedConfig = localStorage.getItem('apiConfig');
      if (savedConfig) {
        const config = JSON.parse(savedConfig);
        return !isValidConfig(config);
      }
    } catch (error) {
      console.error('Error checking config:', error);
    }
    // 默认不显示配置表单
    return false;
  });

  // 故事文本相关状态
  const [storyState, setStoryState] = useState({
    inputText: '', // 输入的故事概要
    storyText: [] as string[], // 故事文本，改为数组
    isFirstStoryLoading: false, // 故事加载状态
  });

  // 播放器相关状态
  const [playerState, setPlayerState] = useState({
    isPlaying: false, // 播放状态
    firstPlayStartTime: null as Date | null, // 播放开始时间
    remainingTime: null as number | null, // 剩余播放时长
  });

  // 预加载相关
  const [preloadState, setPreloadState] = useState({
    preloadStoryText: '',
    isPreloadLoading: false, // 下一故事加载状态
    preloadAudioUrl: null as string | null, // 下一故事音频 URL
    preloadErrorMsg: '', // 预加载错误消息
    preloadRetryCount: 0, // 预加载重试次数
  });

  const audioRef = useRef<AudioPlayerHandle>(null);
  // 使用 useRef 保存最新状态，避免闭包问题
  const storyStateRef = useRef(storyState);
  const playerStateRef = useRef(playerState);
  const preloadStateRef = useRef(preloadState);

  useEffect(() => {
    storyStateRef.current = storyState;
  }, [storyState]);

  useEffect(() => {
    playerStateRef.current = playerState;
  }, [playerState]);

  useEffect(() => {
    preloadStateRef.current = preloadState;
  }, [preloadState]);

  // 如果需要重定向到配置页面
  useEffect(() => {
    if (shouldRedirectToConfig) {
      router.push('/config');
    }
  }, [shouldRedirectToConfig, router]);

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
          const newConfig = { ...apiConfig, playDuration: userInfo.preferences.playDuration };
          setApiConfig(newConfig);
          localStorage.setItem('apiConfig', JSON.stringify(newConfig));
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

  // 播放控制模块：判断是否还在播放时长内
  const getPlayRemainingTime = useCallback((): number => {
    if (!playerStateRef.current.firstPlayStartTime) return 0;
    const elapsedMinutes = (new Date().getTime() - playerStateRef.current.firstPlayStartTime.getTime()) / (1000 * 60);
    return apiConfig.playDuration - elapsedMinutes;
  },[apiConfig.playDuration]);
  
   // 输入框模块：提交生成故事请求
   const handleInputSubmit = async (shortcutText: string) => {
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

      setStoryState(prev => ({
        ...prev,
        isFirstStoryLoading: true,
        inputText: shortcutText,
        storyText: []
      }));
      setPreloadState(prev => ({
        ...prev,
        preloadStoryText: '',
        preloadAudioUrl: null,
        isPreloadLoading: false,
      }));
      setPlayerState(prev => ({
        ...prev,
        firstPlayStartTime: null,
        remainingTime: apiConfig.playDuration,
      }));
      trackEvent('generate_story', 'story', shortcutText);

      const generatedStory = await generateStory(shortcutText, apiConfig);
      const audioUrl = await fetchAudio(generatedStory, apiConfig);

      playNextAudioSrc(audioUrl, generatedStory);
      setPlayerState(prev => ({ ...prev, firstPlayStartTime: new Date() }));
      trackEvent('story_generated', 'story_success', shortcutText, generatedStory.length);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '发生未知错误';
      Toast({ message: errorMessage });
      trackEvent('generation_error', 'error', errorMessage);
      console.error('Error:', error);
    } finally {
      setStoryState(prev => ({ ...prev, isFirstStoryLoading: false }));
    }
  };

  // 计时器模块：每秒更新剩余时长
  useEffect(() => {
    if (!playerState.firstPlayStartTime || !playerState.isPlaying) return;
    const timer = setInterval(() => {
      const remaining = getPlayRemainingTime();
      if (remaining <= 0 && audioRef.current) {
        audioRef.current.pause();
        setPlayerState(prev => ({ ...prev, remainingTime: 0 }));
        clearInterval(timer);
      } else {
        setPlayerState(prev => ({ ...prev, remainingTime: remaining }));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [playerState.firstPlayStartTime, apiConfig.playDuration, playerState.isPlaying, getPlayRemainingTime]);

  // 播放控制模块：预加载下一段故事，加载完成后自动播放或保存预加载数据
  const preloadNextStory = async (retryCount = 0) => {
    if (
      preloadStateRef.current.isPreloadLoading ||
      !storyStateRef.current.storyText.length ||
      !storyStateRef.current.inputText
    ) {
      console.log('[preloadNextStory]预加载被跳过:', {
        isPreloadLoading: preloadStateRef.current.isPreloadLoading,
        hasStory: !!storyStateRef.current.storyText.length,
      });
      return;
    }
    try {
      console.log('[preloadNextStory]开始预加载下一段故事');
      setPreloadState(prev => ({ ...prev, isPreloadLoading: true, preloadErrorMsg: '' }));
      const continuedStory = await continueStory(
        storyStateRef.current.inputText,
        storyStateRef.current.storyText.join(''),
        apiConfig
      );
      console.log('[preloadNextStory]故事生成完成，开始生成音频');
      const audioUrl = await fetchAudio(continuedStory, apiConfig);
      console.log('[preloadNextStory]音频生成完成');

      if (!playerStateRef.current.isPlaying && getPlayRemainingTime() > 0) {
        console.log('[preloadNextStory]当前没有播放，直接开始播放新内容');
        await playNextAudioSrc(audioUrl, continuedStory);
      } else {
        console.log('[preloadNextStory]保存预加载内容');
        setPreloadState(prev => ({
          ...prev,
          preloadAudioUrl: audioUrl,
          preloadStoryText: continuedStory,
        }));
      }
      // 重置错误重试计数
      setPreloadState(prev => ({ ...prev, preloadRetryCount: 0 }));
    } catch (error) {
      console.error('[preloadNextStory]预加载失败:', error);
      if (retryCount < 3) {
        console.log(`[preloadNextStory]预加载失败，5秒后进行第${retryCount + 1}次重试`);
        setTimeout(() => {
          preloadNextStory(retryCount + 1);
        }, 5000);
      }
      const errorMessage = error instanceof Error ? error.message : '预加载失败';
      setPreloadState(prev => ({
        ...prev,
        preloadRetryCount: retryCount + 1,
        preloadErrorMsg: errorMessage,
      }));
    } finally {
      setPreloadState(prev => ({ ...prev, isPreloadLoading: false }));
    }
  };

  // 播放控制模块：切换到下一段音频，清空预加载信息并播放
  const playNextAudioSrc = async (audioUrl: string, nextStoryContent: string) => {
    console.log('[playNextAudioSrc]准备播放一段音频');
    setStoryState(prev => ({ 
      ...prev, 
      storyText: [...prev.storyText, nextStoryContent] 
    }));
    setPreloadState(prev => ({ ...prev, preloadStoryText: '', preloadAudioUrl: null }));
    if (audioRef.current) {
      audioRef.current.play(audioUrl);
    }
  };

  // 播放控制模块：音频播放结束时处理
  const handleAudioEndedCallback = async () => {
    console.log('[handleAudioEndedCallback]音频播放结束');
    if (audioRef.current) {
      audioRef.current.pause();
    }
    trackEvent('audio_completed', 'playback');
    await new Promise(resolve => setTimeout(resolve, 50));
    if (getPlayRemainingTime() <= 0) {
      console.log('[handleAudioEndedCallback]达到设定播放时长，停止播放');
      return;
    }
    if (preloadStateRef.current.preloadAudioUrl) {
      console.log('[handleAudioEndedCallback]使用预加载的内容直接播放');
      await playNextAudioSrc(
        preloadStateRef.current.preloadAudioUrl,
        preloadStateRef.current.preloadStoryText
      );
      // 预加载中则等待其完成，否则开启新的预加载
    } else if (!preloadStateRef.current.isPreloadLoading) {
      console.log('[handleAudioEndedCallback]音频已经结束，开始预加载');
      preloadNextStory();
    }
  };

  // 播放控制模块：音频即将结束时触发预加载
  const handleNearEndCallback = () => {
    if (
      getPlayRemainingTime() > 0 &&
      !preloadStateRef.current.isPreloadLoading &&
      !preloadStateRef.current.preloadAudioUrl
    ) {
      console.log('[handleNearEndCallback]音频即将结束，开始预加载下一段');
      preloadNextStory();
    }
  };

  // 播放控制模块：播放器播放回调
  const handlePlayCallback = useCallback(() => {
    setPlayerState(prev => ({ ...prev, isPlaying: true }));
    trackEvent('audio_play', 'playback');
  }, []);

  // 播放控制模块：播放器暂停回调
  const handlePauseCallback = useCallback(() => {
    setPlayerState(prev => ({ ...prev, isPlaying: false }));
    trackEvent('audio_pause', 'playback');
  }, []);

  // 添加刷新用户信息的函数
  const handleRefreshUserInfo = () => {
    getUserInfo();
    Toast({ message: '用户信息已刷新' });
  };

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
          inputText={storyState.inputText}
          isFirstStoryLoading={storyState.isFirstStoryLoading}
          handleSubmit={handleInputSubmit}
          
          // PlayStatusSection props
          remainingTime={playerState.remainingTime === null ? apiConfig.playDuration : playerState.remainingTime}
          isPreloadLoading={preloadState.isPreloadLoading}
          preloadRetryCount={preloadState.preloadRetryCount}
          preloadErrorMsg={preloadState.preloadErrorMsg}
          preloadAudioUrl={preloadState.preloadAudioUrl}
        />

        <AudioPlayer
          ref={audioRef}
          onPlay={handlePlayCallback}
          onPause={handlePauseCallback}
          onEnded={handleAudioEndedCallback}
          onNearEnd={handleNearEndCallback}
        />

        <StoryViewer
          storyList={storyState.storyText}
        />
      </div>
    </div>
  );
};

export default HomePage;