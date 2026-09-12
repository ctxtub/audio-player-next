import React from 'react';
import Link from 'next/link';
import styles from './index.module.scss';

/**
 * 故事未找到或 ID 结构校验不通过时的 Not Found 界面（M1-02 骨架）。
 * 当 id 校验不通过（如 0, -1, foo, 1.2）或作品不存在时由 notFound() 触发。
 * 遵循 Spec 4.5 与统一布局原则：直接处于 (main) 共享 Layout 内。
 */
export default function NotFound() {
  return (
    <div className={styles.storyDetailPage} data-testid="story-not-found">
      <header className={styles.detailHero}>
        <p className={styles.heroLabel}>404 Not Found</p>
        <h1 className={styles.heroTitle}>故事未找到</h1>
      </header>
      <main className={styles.detailContent}>
        <div className={styles.shellPlaceholder}>
          <p className={styles.placeholderText}>未找到指定的故事或请求参数非法。</p>
          <Link href="/library" className={styles.backLink} data-testid="back-to-library-link">
            返回故事库
          </Link>
        </div>
      </main>
    </div>
  );
}
