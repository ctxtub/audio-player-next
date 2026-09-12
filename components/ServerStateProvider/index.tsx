'use client';

import React, { useMemo, useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import {
  getQueryClient,
  computeIdentityFingerprint,
  clearQueryClientForIdentityTransition,
} from '@/lib/client/queryClient';

export interface ServerStateProviderProps {
  children: React.ReactNode;
  queryClient?: QueryClient;
}

/**
 * ServerStateProvider / MainQueryProvider:
 * 建立 Server State 基础设施并负责身份切换时的缓存与在途请求清理。
 *
 * 挂载位置：AccountSyncProvider 内部、主 UI（ThemeConfigBridge、页面、导航、音频浮窗）外部。
 * 首次 mount 时身份已由 AccountSyncProvider 解析完成（initialized 为 true 且 config 已加载）；
 * 后续发生登录、注册、登出、切号、访客模式切换时，立即触发 cancelQueries() + clear()，
 * 杜绝跨身份数据延迟复活与缓存穿透。
 */
export const ServerStateProvider: React.FC<ServerStateProviderProps> = ({
  children,
  queryClient: customClient,
}) => {
  const queryClient = useMemo(
    () => customClient ?? getQueryClient(),
    [customClient]
  );

  // 严格仅以 initialized、isLogin、isGuest、username 作为身份信号（忽略 nickname / loading）
  const initialized = useAuthStore((state) => state.initialized);
  const isLogin = useAuthStore((state) => state.isLogin);
  const isGuest = useAuthStore((state) => state.isGuest);
  const username = useAuthStore((state) => state.username);

  const currentFingerprint = computeIdentityFingerprint({
    initialized,
    isLogin,
    isGuest,
    username,
  });

  const lastFingerprintRef = useRef<string | null>(null);

  // 1) React 渲染周期内的身份指纹跃迁防护
  useEffect(() => {
    if (!initialized) {
      return;
    }
    if (
      lastFingerprintRef.current !== null &&
      lastFingerprintRef.current !== currentFingerprint
    ) {
      void clearQueryClientForIdentityTransition(queryClient);
    }
    lastFingerprintRef.current = currentFingerprint;
  }, [initialized, currentFingerprint, queryClient]);

  // 2) Zustand store 同步订阅：在 action 调用 setState 发生的瞬间立即取消并清空，
  // 确保在任何后续异步回调或组件重渲染前，旧身份的缓存已彻底清除
  useEffect(() => {
    let prevFingerprint = initialized ? currentFingerprint : null;

    const unsubscribe = useAuthStore.subscribe((state) => {
      if (!state.initialized) {
        return;
      }
      const nextFingerprint = computeIdentityFingerprint({
        initialized: state.initialized,
        isLogin: state.isLogin,
        isGuest: state.isGuest,
        username: state.username,
      });

      if (prevFingerprint !== null && prevFingerprint !== nextFingerprint) {
        void clearQueryClientForIdentityTransition(queryClient);
      }
      prevFingerprint = nextFingerprint;
    });

    return () => {
      unsubscribe();
    };
  }, [queryClient, initialized, currentFingerprint]);

  return React.createElement(QueryClientProvider, { client: queryClient }, children);
};

export { ServerStateProvider as MainQueryProvider };
export default ServerStateProvider;
