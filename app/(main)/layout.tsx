import React from 'react';
import MainChrome from '@/components/MainChrome';
import AudioControllerHost from '@/components/AudioControllerHost';
import AccountSyncProvider from '@/components/AccountSyncProvider';
import ServerStateProvider from '@/components/ServerStateProvider';
import ThemeConfigBridge from '@/components/ThemeConfigBridge';
/**
 * 主应用布局：MainChrome（内容 + BottomChrome{Mini slot + TabBar}）与
 * AudioControllerHost 平级挂载。
 *
 * Mini 已成为全局应用框架的一部分，收进 .app 内的
 * BottomChrome slot；AudioControllerHost 仍为全局唯一 audio owner，
 * 与 MainChrome 平级（MainChrome 重渲染不触 Host 子树），跨
 * /chat /library /setting 不重复挂载、不重复 beginSession。
 * 布局层不修改播放会话的身份、状态、来源或连续播放模式。
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
      </ServerStateProvider>
    </AccountSyncProvider>
  );
}
