import React from 'react';
import styles from './index.module.scss';

/**
 * 故事库主页路由 Shell 组件（M1-02 骨架）。
 * 暂不实现数据能力与 StoryWork 查询（归 M2/M3 接管）。
 * @returns 故事库骨架 JSX 结构
 */
const LibraryPage: React.FC = () => {
  return (
    <div className={styles.libraryPage} data-testid="library-page-shell">
      <header className={styles.libraryHero}>
        <p className={styles.heroLabel}>Story Library</p>
        <h1 className={styles.heroTitle}>故事库</h1>
      </header>
      <main className={styles.libraryContent}>
        {/* M1 阶段仅建立 Route Shell，真实数据列表与筛选由 M3 接管 */}
        <div className={styles.shellPlaceholder} data-testid="library-shell-placeholder">
          <p className={styles.placeholderText}>故事库内容加载中...</p>
        </div>
      </main>
    </div>
  );
};

export default LibraryPage;
