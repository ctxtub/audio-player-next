'use client';

import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import styles from './libraryComponents.module.scss';

export interface LibraryErrorStateProps {
  error?: Error | null;
  onRetry: () => void;
}

/**
 * 故事库全屏初始错误状态组件（带重试按钮）
 */
export const LibraryErrorState: React.FC<LibraryErrorStateProps> = ({
  error,
  onRetry,
}) => {
  return (
    <div className={styles.errorContainer} data-testid="library-initial-error">
      <div className={styles.errorIconWrapper}>
        <AlertCircle size={24} />
      </div>
      <h3 className={styles.errorTitle}>故事库加载失败</h3>
      <p className={styles.emptySubtitle}>
        {error?.message || '网络或服务异常，无法获取故事列表'}
      </p>
      <button
        type="button"
        className={styles.retryBtn}
        onClick={onRetry}
        data-testid="library-retry-btn"
      >
        <RefreshCw size={14} />
        <span>重试</span>
      </button>
    </div>
  );
};
