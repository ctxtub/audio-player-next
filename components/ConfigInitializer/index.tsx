'use client';

import React, { PropsWithChildren, useEffect } from 'react';
import { useConfigStore } from '@/stores/configStore';
import { PageLoading } from '@/components/PageLoading';

/**
 * 配置加载组件，用于确保配置已初始化再渲染子节点。
 * @param children React.ReactNode 页面或布局内容
 * @returns 公共配置加载处理后的内容
 */
export const ConfigInitializer: React.FC<PropsWithChildren> = ({ children }) => {
  const initializeConfig = useConfigStore(state => state.initialize);
  const isConfigLoaded = useConfigStore(state => state.isLoaded);

  useEffect(() => {
    initializeConfig().catch(() => {});
  }, [initializeConfig]);

  if (!isConfigLoaded) {
    return <PageLoading message="配置加载中..." />;
  }

  return <>{children}</>;
};

export default ConfigInitializer;
