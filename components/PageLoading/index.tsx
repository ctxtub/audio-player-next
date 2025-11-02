import React from 'react';
import { SpinLoading } from 'antd-mobile';
import styles from './index.module.scss';

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
  <div className={styles.loadingContainer} role="status" aria-live="polite">
    <SpinLoading className={styles.spinner} color="primary" />
    {message ? <p className={styles.message}>{message}</p> : null}
  </div>
);
