'use client';

import React, { useCallback } from 'react';

import { retryContinuousCreation } from '@/app/services/continuousCreationFlow';
import {
  CONTINUOUS_CREATION_STATUS_LABEL,
  useContinuousCreationStore,
} from '@/stores/continuousCreationStore';
import type { ContinuousCreationStatus } from '@/lib/continuous-creation/stateMachine';

import styles from './index.module.scss';

/**
 * 需要展示下一篇进展的状态（空闲/关闭时不展示，由顶部 Bar 承担）。
 * ended_budget 展示结束横幅，error 展示失败与重试/关闭。
 */
const VISIBLE_STATUSES: ReadonlySet<ContinuousCreationStatus> = new Set([
  'generating_next',
  'saving_next_work',
  'preparing_audio',
  'next_ready',
  'waiting_next',
  'ended_budget',
  'error',
]);

/** 展示 spinner 的在途状态。 */
const SPINNER_STATUSES: ReadonlySet<ContinuousCreationStatus> = new Set([
  'generating_next',
  'saving_next_work',
  'preparing_audio',
  'waiting_next',
]);

/**
 * 下一篇生命周期卡（聊天内容流末端）。
 *
 * 与编排同源：状态文案与下一篇身份全部只读 `continuousCreationStore`，
 * 组件自身不推导状态、不做 IO。失败只展示中性文案与重试/关闭，
 * 不暴露技术错误；等待态明确告知不消耗预算。
 * @returns 下一篇卡片 JSX；无在途/就绪/等待/失败/结束时返回 null。
 */
const ContinuousCreationCard: React.FC = () => {
  const status = useContinuousCreationStore((state) => state.status);
  const nextWork = useContinuousCreationStore((state) => state.nextWork);
  const disable = useContinuousCreationStore((state) => state.disable);

  const handleRetry = useCallback(() => {
    retryContinuousCreation();
  }, []);

  const handleClose = useCallback(() => {
    disable();
  }, [disable]);

  if (!VISIBLE_STATUSES.has(status)) {
    return null;
  }

  const title = nextWork?.title?.trim() ? nextWork.title.trim() : null;
  const isError = status === 'error';
  const isWaiting = status === 'waiting_next';
  const isEnded = status === 'ended_budget';

  return (
    <section className={styles.card} aria-label="下一篇" data-testid="continuous-next-card">
      {SPINNER_STATUSES.has(status) ? (
        <span className={styles.spinner} aria-hidden="true" />
      ) : null}
      <div className={styles.textGroup}>
        <span className={styles.status} role="status">
          {CONTINUOUS_CREATION_STATUS_LABEL[status]}
        </span>
        {title ? <span className={styles.title}>{title}</span> : null}
        {isWaiting ? (
          <span className={styles.hint}>等待期间不消耗播放预算</span>
        ) : null}
      </div>
      {isError ? (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.retryButton}
            onClick={handleRetry}
            data-testid="continuous-next-retry"
          >
            重试
          </button>
          <button
            type="button"
            className={styles.closeButton}
            onClick={handleClose}
            data-testid="continuous-next-close"
          >
            关闭连续创作
          </button>
        </div>
      ) : null}
      {isEnded ? (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.closeButton}
            onClick={handleClose}
            data-testid="continuous-next-close"
          >
            关闭
          </button>
        </div>
      ) : null}
    </section>
  );
};

export default ContinuousCreationCard;
