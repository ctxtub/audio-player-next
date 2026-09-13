'use client';

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import PlaybackStatusBoard from '@/app/(main)/player/components/PlaybackStatusBoard';
import GenerationPreview from '@/app/(main)/player/components/GenerationPreview';
import AudioPlayer from '@/app/(main)/player/components/AudioPlayer';

import { useConfigStore } from '@/stores/configStore';
import styles from './index.module.scss';

/**
 * 播放器页：纯 playback/compatibility surface。历史 Surface 已回迁 Chat（M4-07）。
 * 本页仅保留播放主体（PlaybackStatusBoard / GenerationPreview / AudioPlayer），不再拥有 History UI。
 * @returns 播放器页 JSX 结构
 */
const HomePage: React.FC = () => {
  /** 路由：配置无效时跳转配置页。 */
  const router = useRouter();

  // 配置加载与校验（登录/访客初始化已由 AccountSyncProvider 全局接管）
  const isConfigLoaded = useConfigStore(state => state.isLoaded);
  const configIsValid = useConfigStore(state => state.isConfigValid());

  useEffect(() => {
    if (!isConfigLoaded) {
      return;
    }
    if (!configIsValid) {
      router.push('/setting');
    }
  }, [isConfigLoaded, configIsValid, router]);

  return (
    <div className={styles.homePage}>
      <div className={styles.pageSection}>
        <PlaybackStatusBoard />

        <GenerationPreview />

        <AudioPlayer />
      </div>
    </div>
  );
};

export default HomePage;
