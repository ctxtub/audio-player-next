'use client';

import Link from 'next/link';
import { resetContinuousCreationDuration } from '@/app/services/continuousCreationSession';
import { useChatStore } from '@/stores/chatStore';
import { useConfigStore } from '@/stores/configStore';
import { collectionPath } from '@/lib/navigation/storyRoutes';
import React from 'react';
import GlassSlider from '@/components/ui/GlassSlider';
import GlassSwitch from '@/components/ui/GlassSwitch';
import {
  SLEEP_TIMER_MAX_MINUTES,
  SLEEP_TIMER_MIN_MINUTES,
  SLEEP_TIMER_STEP_MINUTES,
} from '@/lib/playback/sleepTimer';

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
 *   连续创作状态卡。
 *
 * 本次状态与剩余预算只读 `continuousCreationStore`；启停和时长复用配置 store，
 * 与设置页保持一致。开关和滑块带可访问名称。
 * @param props.collectionTitle 当前集合标题。
 * @returns 状态卡 JSX。
 */
const ContinuousCreationBar: React.FC<ContinuousCreationBarProps> = ({ collectionTitle }) => {
  const collectionId = useChatStore((state) => state.collectionId);
  const enabled = useContinuousCreationStore((state) => state.enabled);
  const status = useContinuousCreationStore((state) => state.status);
  const remainingMs = useContinuousCreationStore((state) => state.remainingMs);
  const ready = useContinuousCreationStore((state) => state.ready);
  const budgetMs = useContinuousCreationStore((state) => state.budgetMs);
  const config = useConfigStore((state) => state.apiConfig);
  const configReady = useConfigStore((state) => state.isLoaded);
  const updateConfig = useConfigStore((state) => state.update);

  const title = collectionTitle && collectionTitle.trim().length > 0 ? collectionTitle : '新作品集';

  return (
    <section className={styles.container} aria-label="连续创作">
      <div className={styles.titleRow}>
        <span className={styles.collectionLabel}>正在创作</span>
        <span className={styles.collectionTitle} data-testid="continuous-collection-title">
          {collectionId ? <Link href={collectionPath(collectionId)}>{title}</Link> : title}
        </span>
      </div>

      <div className={styles.controlRow}>
        <div className={styles.statusCard} data-testid="continuous-status-card">
          <span className={`${styles.statusDot} ${enabled ? styles.statusDotOn : styles.statusDotOff}`} />
          <span className={styles.statusText} role="status">
            {ready ? CONTINUOUS_CREATION_STATUS_LABEL[status] : '正在恢复本次创作…'}
          </span>
        </div>

        <span className={styles.budget} data-testid="continuous-remaining-budget">
          {enabled
            ? `自动播放时长 · ${budgetMs ? `${Math.round(budgetMs / 60000)}分钟` : '加载中'} · 剩余 ${ready ? formatRemainingMs(remainingMs) : '—'}`
            : `时长偏好 · ${config.defaultSleepTimerMinutes || 30}分钟`}
        </span>

        {ready && configReady ? <div className={styles.directControls}>
          <div className={styles.toggleLabel}>
            <span>自动播放与连续创作</span>
            <GlassSwitch
              isSelected={config.defaultSleepTimerEnabled}
              onChange={(next) => updateConfig({ defaultSleepTimerEnabled: next })}
              label="自动播放与连续创作开关"
            />
          </div>
          <div className={styles.durationControl}>
            <span>本次时长 · {config.defaultSleepTimerMinutes}分钟</span>
            <GlassSlider
              min={SLEEP_TIMER_MIN_MINUTES}
              max={SLEEP_TIMER_MAX_MINUTES}
              step={SLEEP_TIMER_STEP_MINUTES}
              value={config.defaultSleepTimerMinutes || 30}
              onChange={(minutes) => updateConfig({ defaultSleepTimerMinutes: minutes })}
              label="选择本次自动播放时长"
            />
          </div>
        </div> : <span className={styles.scopeHint}>正在恢复本次控制…</span>}

        <details className={styles.help}>
          <summary>自动播放与连续创作说明</summary>
          <p>开启后，按本次时长自动播放并连续创作；暂停、生成和语音准备期间不计时，刷新保留剩余时长。时长耗尽后停止自动播放与连续创作，可重置时长。关闭后停止自动续播与连续创作，已保存故事仍可手动收听。</p>
        </details>

        {ready && enabled && status === 'ended_budget' && <button type="button" className={styles.action} onClick={resetContinuousCreationDuration}>重置时长</button>}
        <Link className={styles.action} href="/setting">前往设置</Link>
      </div>
    </section>
  );
};

export default ContinuousCreationBar;
