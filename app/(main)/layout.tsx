import React from 'react';
import styles from '@/styles/app.module.scss';
import MainTabBar from '@/components/MainTabBar';
import AudioControllerHost from '@/components/AudioControllerHost';
import { FloatingPlayer } from '@/components/FloatingPlayer';
import ConfigInitializer from '@/components/ConfigInitializer';
/**
 * 主应用布局：包含底部导航、音频控制器。
 */
export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ConfigInitializer>
      <div className={styles.app}>
        <main className={styles.content}>
          {children}
        </main>
        <MainTabBar />
      </div>
      <AudioControllerHost />
      <FloatingPlayer />
    </ConfigInitializer>
  );
}
