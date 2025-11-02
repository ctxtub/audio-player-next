import React, { useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Toast } from 'antd-mobile';
import StoryViewer from '@/components/StoryViewer';
import { PageLoading } from '@/components/PageLoading';
import PlaybackStatusBoard from '@/components/PlaybackStatusBoard';
import { useFloatingPlayer } from '@/components/FloatingPlayer';

import { useConfigStore } from '@/stores/configStore';
import { useStoryStore } from '@/stores/storyStore';
import {
  beginStorySession,
  resetStoryFlow,
} from '@/app/services/storyFlow';
import InputStatusSection from './components/InputStatusSection';
import styles from './index.module.scss';

/**
 * 首页页面组件，负责串联故事生成与音频播放交互。
 * @returns 首页 JSX 结构
 */
const HomePage: React.FC = () => {
  const router = useRouter();
  const { play: playAudio, pause: pauseAudio } = useFloatingPlayer();

  // 配置初始化与校验能力
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

  // 输入框模块：提交生成故事请求
  const handleInputSubmit = useCallback(
    async (shortcutText: string) => {
      try {
        pauseAudio();

        const { audioUrl } = await beginStorySession(shortcutText);

        await playAudio(audioUrl);
        router.push('/player');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '发生未知错误';
        Toast.show({ icon: 'fail', content: errorMessage, duration: 3000 });
        resetStoryFlow();
      }
    },
    [pauseAudio, playAudio, router]
  );

  if (!isConfigLoaded) {
    return <PageLoading message="页面加载中..." />;
  }

  return (
    <div className={styles.homePage}>
      <div className={styles.pageSection}>
        <PlaybackStatusBoard
        />

        <InputStatusSection
          inputText={storyInputText}
          handleSubmit={handleInputSubmit}
        />

        <StoryViewer />
      </div>
    </div>
  );
};

export default HomePage;
