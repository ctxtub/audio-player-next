import React from 'react';
import styles from './index.module.scss';

type PageLoadingProps = {
  message?: string;
};

export const PageLoading: React.FC<PageLoadingProps> = ({ message = '加载中…' }) => (
  <div className={styles.loadingContainer} role="status" aria-live="polite">
    <div className={styles.spinner} />
    <p className={styles.message}>{message}</p>
  </div>
);

