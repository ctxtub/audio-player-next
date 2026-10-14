'use client';

import Link from 'next/link';
import { resetContinuousCreationDuration } from '@/app/services/continuousCreationSession';
import { useChatStore } from '@/stores/chatStore';
import { collectionPath } from '@/lib/navigation/storyRoutes';
import React from 'react';
import { Plus } from 'lucide-react';

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
  onNewCreation?: () => void;
  newCreationDisabled?: boolean;
};

/**
 *   连续创作状态卡。
 *
 * 只读连续创作状态和预算；启停与时长配置在设置页完成。
 * @param props.collectionTitle 当前集合标题。
 * @returns 状态卡 JSX。
 */
const ContinuousCreationBar: React.FC<ContinuousCreationBarProps> = ({ collectionTitle, onNewCreation, newCreationDisabled }) => {
  const collectionId = useChatStore((state) => state.collectionId);
  const enabled = useContinuousCreationStore((state) => state.enabled);
  const status = useContinuousCreationStore((state) => state.status);
  const remainingMs = useContinuousCreationStore((state) => state.remainingMs);
  const ready = useContinuousCreationStore((state) => state.ready);

  const title = collectionTitle && collectionTitle.trim().length > 0 ? collectionTitle : '新作品集';

  return (
    <section className={styles.container} aria-label="连续创作">
      <div className={styles.titleRow}>
        <span className={styles.collectionLabel}>正在创作</span>
        <span className={styles.collectionTitle} data-testid="continuous-collection-title">
          {collectionId ? <Link href={collectionPath(collectionId)}>{title}</Link> : title}
        </span>
        {onNewCreation && <button type="button" className={styles.newCreation} onClick={onNewCreation} disabled={newCreationDisabled}>
          <Plus size={16} aria-hidden="true" />新建故事集
        </button>}
      </div>

      <div className={styles.controlRow}>
        <div className={styles.statusCard} data-testid="continuous-status-card">
          <span className={`${styles.statusDot} ${enabled ? styles.statusDotOn : styles.statusDotOff}`} />
          <span className={styles.statusText} role="status">
            {ready ? CONTINUOUS_CREATION_STATUS_LABEL[status] : '正在恢复本次创作…'}
          </span>
        </div>

        <span className={styles.budget} data-testid="continuous-remaining-budget">
          剩余 {ready ? formatRemainingMs(remainingMs) : '—'}
        </span>

        {ready && enabled && status === 'ended_budget' && <button type="button" className={styles.action} onClick={resetContinuousCreationDuration}>重置时长</button>}
      </div>
    </section>
  );
};

export default ContinuousCreationBar;
