'use client';

import React, { PropsWithChildren, useEffect } from 'react';
import { useConfigStore } from '@/stores/configStore';
import { useAuthStore } from '@/stores/authStore';
import {
  ensureAccountSyncSubscribed,
  initAccountForGuest,
  initAccountForUser,
} from '@/stores/accountSync';
import { PageLoading } from '@/components/PageLoading';

/**
 * 账号数据同步编排组件：先解析登录态，再按登录态统一分发四块数据初始化，
 * 并以应用配置（config）就绪为首屏渲染门。登出/会话失效的清理由 accountSync
 * 订阅 authStore 自动触发（见 ensureAccountSyncSubscribed），此处只管「拉数据进来」。
 */
export const AccountSyncProvider: React.FC<PropsWithChildren> = ({ children }) => {
  /** 应用配置是否已加载（config 是唯一阻塞首屏的块）。 */
  const isConfigLoaded = useConfigStore(state => state.isLoaded);

  const authInitialized = useAuthStore(state => state.initialized);
  const isLogin = useAuthStore(state => state.isLogin);
  const fetchProfile = useAuthStore(state => state.fetchProfile);

  // 1) 确保登录态已解析
  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  // 2) 一次性挂载登出订阅（isLogin 下降沿自动清理账号数据）
  useEffect(() => {
    ensureAccountSyncSubscribed();
  }, []);

  // 3) 登录态确定后，按身份统一分发四块初始化（各块幂等，可安全重复调用）
  useEffect(() => {
    if (!authInitialized) {
      return;
    }
    if (isLogin) {
      initAccountForUser();
    } else {
      initAccountForGuest();
    }
  }, [authInitialized, isLogin]);

  if (!authInitialized || !isConfigLoaded) {
    return <PageLoading message="配置加载中..." />;
  }

  return <>{children}</>;
};

export default AccountSyncProvider;
