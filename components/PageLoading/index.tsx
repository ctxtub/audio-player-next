import React from 'react';
import styles from './index.module.scss';

/**
 * 页面加载态组件的入参。
 */
type PageLoadingProps = {
  message?: string;
};

/**
 * 页面级加载状态组件，展示旋转动画与提示文案。
 * 使用纯 CSS 实现旋转 spinner，无需 antd-mobile 依赖。
 */
export const PageLoading: React.FC<PageLoadingProps> = ({ message = '加载中…' }) => (
  <div className={styles.loadingContainer} role="status" aria-live="polite">
    <div className={styles.spinner} />
    {message ? <p className={styles.message}>{message}</p> : null}
  </div>
);
