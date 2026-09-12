'use client';

import React from 'react';
import styles from './index.module.scss';

export interface StoryDetailPageProps {
  id: string;
}

/**
 * 故事详情页路由 Shell 组件（M1-02 骨架）。
 * 暂不实现数据能力与 StoryWork 查询（归 M2/M3 接管）。
 * @param props 包含已校验合法的作品 ID
 * @returns 故事详情页骨架 JSX 结构
 */
const StoryDetailPage: React.FC<StoryDetailPageProps> = ({ id }) => {
  return (
    <div className={styles.storyDetailPage} data-testid="story-detail-shell">
      <header className={styles.detailHero}>
        <p className={styles.heroLabel}>Story Detail</p>
        <h1 className={styles.heroTitle}>故事 #{id}</h1>
      </header>
      <main className={styles.detailContent}>
        {/* M1 阶段仅建立 Route Shell，真实详情数据与播放交互由 M3 接管 */}
        <div className={styles.shellPlaceholder} data-testid="story-detail-placeholder">
          <p className={styles.placeholderText}>故事 #{id} 详情加载中...</p>
        </div>
      </main>
    </div>
  );
};

export default StoryDetailPage;
