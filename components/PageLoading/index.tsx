import React from 'react';
import { SpinLoading } from 'antd-mobile';
import styles from './index.module.scss';

type PageLoadingProps = {
  message?: string;
};

export const PageLoading: React.FC<PageLoadingProps> = ({ message = '加载中…' }) => (
  <div className={styles.loadingContainer} role="status" aria-live="polite">
    <SpinLoading className={styles.spinner} color="primary" />
    {message ? <p className={styles.message}>{message}</p> : null}
  </div>
);
