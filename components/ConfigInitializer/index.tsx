'use client';

import React, { PropsWithChildren, useEffect } from 'react';
import { useConfigStore } from '@/stores/configStore';
import { useAuthStore } from '@/stores/authStore';
import { PageLoading } from '@/components/PageLoading';

/**
 * 配置编排组件：先解析登录态，再按登录态选择配置初始化路径。
 * - 已登录：initForUser（服务端为准 + 本地 seed 迁移 + 开启回写）
 * - 未登录/访客：initialize（纯本地 + 系统级音色）
 */
export const ConfigInitializer: React.FC<PropsWithChildren> = ({ children }) => {
  const initializeLocal = useConfigStore(state => state.initialize);
  const initForUser = useConfigStore(state => state.initForUser);
  const isConfigLoaded = useConfigStore(state => state.isLoaded);

  const authInitialized = useAuthStore(state => state.initialized);
  const isLogin = useAuthStore(state => state.isLogin);
  const fetchProfile = useAuthStore(state => state.fetchProfile);

  // 1) 确保登录态已解析
  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  // 2) 登录态确定后，按身份选择初始化路径（仅当配置未加载时）
  useEffect(() => {
    if (!authInitialized || isConfigLoaded) {
      return;
    }
    const run = isLogin ? initForUser : initializeLocal;
    run().catch(() => {});
  }, [authInitialized, isConfigLoaded, isLogin, initForUser, initializeLocal]);

  if (!authInitialized || !isConfigLoaded) {
    return <PageLoading message="配置加载中..." />;
  }

  return <>{children}</>;
};

export default ConfigInitializer;
