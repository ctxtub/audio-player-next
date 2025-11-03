import React from 'react';
import { SpinLoading } from 'antd-mobile';

/**
 * 页面加载态组件的入参。
 */
type PageLoadingProps = {
  message?: string;
};

/**
 * 页面级加载状态组件，展示旋转动画与提示文案。
 */
export const PageLoading: React.FC<PageLoadingProps> = ({ message = '加载中…' }) => (
  <div
    className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--background)] p-6 text-center text-[var(--foreground)]"
    role="status"
    aria-live="polite"
  >
    <SpinLoading
      className="[--size:48px]"
      color="primary"
      style={{ '--color': 'var(--foreground)' } as React.CSSProperties}
    />
    {message ? <p className="text-[16px] tracking-[0.4px]">{message}</p> : null}
  </div>
);
