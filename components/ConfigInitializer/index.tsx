'use client';

import React, { PropsWithChildren, useCallback, useEffect } from 'react';
import { useConfigStore } from '@/stores/configStore';
import { PageLoading } from '@/components/PageLoading';

/**
 * 配置加载组件，用于确保配置已初始化再渲染子节点。
 * 初始化失败时展示错误提示与重试按钮。
 * @param children React.ReactNode 页面或布局内容
 * @returns 公共配置加载处理后的内容
 */
export const ConfigInitializer: React.FC<PropsWithChildren> = ({ children }) => {
  const initializeConfig = useConfigStore(state => state.initialize);
  const isConfigLoaded = useConfigStore(state => state.isLoaded);
  const initError = useConfigStore(state => state.initError);

  useEffect(() => {
    initializeConfig().catch(() => {});
  }, [initializeConfig]);

  /** 点击重试，重新触发初始化 */
  const handleRetry = useCallback(() => {
    initializeConfig().catch(() => {});
  }, [initializeConfig]);

  if (initError) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: '12px' }}>
        <p style={{ color: 'var(--adm-color-danger, #ff3141)' }}>配置加载失败</p>
        <button
          onClick={handleRetry}
          style={{ padding: '8px 24px', borderRadius: '8px', border: '1px solid var(--adm-border-color, #eee)', background: 'var(--adm-color-background, #fff)', cursor: 'pointer' }}
        >
          重试
        </button>
      </div>
    );
  }

  if (!isConfigLoaded) {
    return <PageLoading message="配置加载中..." />;
  }

  return <>{children}</>;
};

export default ConfigInitializer;
