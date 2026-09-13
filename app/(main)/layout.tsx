import React from 'react';
import styles from '@/styles/app.module.scss';
import MainTabBar from '@/components/MainTabBar';
import AudioControllerHost from '@/components/AudioControllerHost';
import PlaybackSessionProbe from '@/components/PlaybackSessionProbe';
import { FloatingPlayer } from '@/components/FloatingPlayer';
import AccountSyncProvider from '@/components/AccountSyncProvider';
import ServerStateProvider from '@/components/ServerStateProvider';
import ThemeConfigBridge from '@/components/ThemeConfigBridge';
/**
 * 主应用布局：包含底部导航、音频控制器。
 */
export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AccountSyncProvider>
      <ServerStateProvider>
        <ThemeConfigBridge />
        <div className={styles.app}>
          <main className={styles.content}>
            {children}
          </main>
          <MainTabBar />
        </div>
        <AudioControllerHost />
        <PlaybackSessionProbe />
        <FloatingPlayer />
      </ServerStateProvider>
    </AccountSyncProvider>
  );
}
