import React from 'react';
import styles from '@/styles/app.module.scss';
import MainTabBar from '@/components/MainTabBar';
import AudioControllerHost from '@/components/AudioControllerHost';
import PlaybackSessionProbe from '@/components/PlaybackSessionProbe';
import { isBrowserTestRuntime } from '@/components/PlaybackSessionProbe/probeFlag';
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
        {/* M5-10 fixup-2 双保险之一：普通 runtime 不挂载 Probe（组件执行路径不进）；仅显式开启的 browser test runtime 挂载。 */}
        {isBrowserTestRuntime() ? <PlaybackSessionProbe /> : null}
        <FloatingPlayer />
      </ServerStateProvider>
    </AccountSyncProvider>
  );
}
