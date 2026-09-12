'use client';

import React, { useMemo, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import {
  getQueryClient,
  computeIdentityFingerprint,
  clearQueryClientForIdentityTransition,
} from '@/lib/client/queryClient';

export interface ServerStateProviderProps {
  children?: React.ReactNode;
  queryClient?: QueryClient;
}

/**
 * ServerStateProvider / MainQueryProvider:
 * 建立 Server State 基础设施并负责身份切换时的缓存与在途请求清理。
 *
 * 挂载位置：AccountSyncProvider 内部、主 UI（ThemeConfigBridge、页面、导航、音频浮窗）外部。
 * 首次 mount 时身份已由 AccountSyncProvider 解析完成（initialized 为 true 且 config 已加载）；
 * 后续发生登录、注册、登出、切号、访客模式切换时，严格由唯一权威路径（Zustand 同步订阅）
 * 触发 cancelQueries() + clear()，杜绝跨身份数据延迟复活与 render 周期二次清理。
 */
export const ServerStateProvider: React.FC<ServerStateProviderProps> = ({
  children,
  queryClient: customClient,
}) => {
  const queryClient = useMemo(
    () => customClient ?? getQueryClient(),
    [customClient]
  );

  // 单一权威清理路径：基于 Zustand 同步订阅，确保在 setState 发生的瞬间立即完成清理。
  // 依赖项仅为 [queryClient]，不在 render 周期中进行二次清理，避免误杀新身份的在途或初装 query。
  useEffect(() => {
    const initialState = useAuthStore.getState();
    let prevFingerprint = initialState.initialized
      ? computeIdentityFingerprint({
          initialized: initialState.initialized,
          isLogin: initialState.isLogin,
          isGuest: initialState.isGuest,
          username: initialState.username,
        })
      : null;

    return useAuthStore.subscribe((state) => {
      if (!state.initialized) {
        prevFingerprint = null;
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
  }, [queryClient]);

  return React.createElement(QueryClientProvider, { client: queryClient }, children);
};

export { ServerStateProvider as MainQueryProvider };
export default ServerStateProvider;
