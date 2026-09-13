import React from 'react';
import MainChrome from '@/components/MainChrome';
import AudioControllerHost from '@/components/AudioControllerHost';
import PlaybackSessionProbe from '@/components/PlaybackSessionProbe';
import { isBrowserTestRuntime } from '@/components/PlaybackSessionProbe/probeFlag';
import AccountSyncProvider from '@/components/AccountSyncProvider';
import ServerStateProvider from '@/components/ServerStateProvider';
import ThemeConfigBridge from '@/components/ThemeConfigBridge';
/**
 * 主应用布局：MainChrome（内容 + BottomChrome{Mini slot + TabBar}）与
 * AudioControllerHost 平级挂载。
 *
 * M6-03（spec §16）：Mini 已成为 Global App Chrome，收进 .app 内的
 * BottomChrome slot；AudioControllerHost 仍为全局唯一 audio owner，
 * 与 MainChrome 平级（MainChrome 重渲染不触 Host 子树），跨
 * /chat /library /setting 不重复挂载、不重复 beginSession。
 * M5 owner 边界：布局层不 mutation sessionId/status/source/continuationMode。
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
        <MainChrome>{children}</MainChrome>
        <AudioControllerHost />
        {/* M5-10 fixup-2 双保险之一：普通 runtime 不挂载 Probe（组件执行路径不进）；仅显式开启的 browser test runtime 挂载。 */}
        {isBrowserTestRuntime() ? <PlaybackSessionProbe /> : null}
      </ServerStateProvider>
    </AccountSyncProvider>
  );
}
