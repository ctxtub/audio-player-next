'use client';

import React, { useCallback } from 'react';

import {
  CONTINUOUS_CREATION_STATUS_LABEL,
  formatRemainingMs,
  useContinuousCreationStore,
} from '@/stores/continuousCreationStore';

import styles from './index.module.scss';

/**
 * 连续创作状态卡 props。
 */
export type ContinuousCreationBarProps = {
  /** 当前集合标题；null/缺省展示空闲态。 */
  collectionTitle?: string | null;
};

/**
 * M9-C1 T2 连续创作状态卡。
 *
 * 与编排同源：开关、状态文案与剩余预算全部只读 `continuousCreationStore`（薄封装纯状态机），
 * 组件自身不推导状态、不做 IO。开关带可访问名称。
 * @param props.collectionTitle 当前集合标题。
 * @returns 状态卡 JSX。
 */
const ContinuousCreationBar: React.FC<ContinuousCreationBarProps> = ({ collectionTitle }) => {
  const enabled = useContinuousCreationStore((state) => state.enabled);
  const status = useContinuousCreationStore((state) => state.status);
  const remainingMs = useContinuousCreationStore((state) => state.remainingMs);
  const enable = useContinuousCreationStore((state) => state.enable);
  const disable = useContinuousCreationStore((state) => state.disable);

  const handleToggle = useCallback(() => {
    if (enabled) {
      disable();
    } else {
      enable();
    }
  }, [enabled, enable, disable]);

  const title = collectionTitle && collectionTitle.trim().length > 0 ? collectionTitle : '新作品集';

  return (
    <section className={styles.container} aria-label="连续创作">
      <div className={styles.titleRow}>
        <span className={styles.collectionLabel}>作品集</span>
        <span className={styles.collectionTitle} data-testid="continuous-collection-title">
          {title}
        </span>
      </div>

      <div className={styles.controlRow}>
        <div className={styles.statusCard} data-testid="continuous-status-card">
          <span className={`${styles.statusDot} ${enabled ? styles.statusDotOn : styles.statusDotOff}`} />
          <span className={styles.statusText} role="status">
            {CONTINUOUS_CREATION_STATUS_LABEL[status]}
          </span>
        </div>

        <span className={styles.budget} data-testid="continuous-remaining-budget">
          剩余 {formatRemainingMs(remainingMs)}
        </span>

        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="连续创作开关"
          className={`${styles.switch} ${enabled ? styles.switchOn : ''}`}
          onClick={handleToggle}
          data-testid="continuous-switch"
        >
          <span className={styles.switchThumb} />
        </button>
      </div>
    </section>
  );
};

export default ContinuousCreationBar;
