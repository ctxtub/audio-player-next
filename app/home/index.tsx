'use client';

import React, { useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Toast } from 'antd-mobile';
import PlaybackStatusBoard from '@/components/PlaybackStatusBoard';
import GenerationPreview from '@/components/GenerationPreview';
import { useFloatingPlayer } from '@/components/FloatingPlayer';
import AudioPlayer from '@/components/AudioPlayer';

import { useConfigStore } from '@/stores/configStore';
import { useChatStore } from '@/stores/chatStore';
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
  const { ensureUnlocked, play: playAudio, pause: pauseAudio } = useFloatingPlayer();

  // 配置初始化与校验能力
  const isConfigLoaded = useConfigStore(state => state.isLoaded);
  const configIsValid = useConfigStore(state => state.isConfigValid());

  useEffect(() => {
    if (!isConfigLoaded) {
      return;
    }
    if (!configIsValid) {
      router.push('/config');
    }
  }, [isConfigLoaded, configIsValid, router]);

  // 故事状态
  const storyInputText = useChatStore((state) => state.getStoryContext().prompt);

  // 输入框模块：提交生成故事请求
  const handleInputSubmit = useCallback(
    async (shortcutText: string) => {
      try {
        pauseAudio();

        await ensureUnlocked();

        const { audioUrl, messageId } = await beginStorySession(shortcutText);
        await playAudio(audioUrl, messageId);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '发生未知错误';
        Toast.show({ icon: 'fail', content: errorMessage, duration: 3000 });
        resetStoryFlow();
      }
    },
    [ensureUnlocked, pauseAudio, playAudio, router]
  );

  return (
    <div className={styles.homePage}>
      <div className={styles.pageSection}>
        <PlaybackStatusBoard
        />

        <GenerationPreview />

        <InputStatusSection
          inputText={storyInputText}
          handleSubmit={handleInputSubmit}
        />

        <AudioPlayer />
      </div>
    </div>
  );
};

export default HomePage;
