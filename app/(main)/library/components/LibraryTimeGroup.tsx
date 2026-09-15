'use client';

import React from 'react';
import type { LibraryView } from '@/lib/client/library';
import type { StoryWorkTimeGroup } from '@/lib/client/libraryGrouping';
import { StoryWorkCard } from './StoryWorkCard';
import styles from './libraryComponents.module.scss';

export interface LibraryTimeGroupProps {
  group: StoryWorkTimeGroup;
  view: LibraryView;
}

/**
 * 故事库时间分组渲染组件
 */
export const LibraryTimeGroup: React.FC<LibraryTimeGroupProps> = ({ group, view }) => {
  return (
    <section
      className={styles.timeGroup}
      data-testid={`library-time-group-${group.label}`}
      aria-label={`${group.label}的故事`}
    >
      <div className={styles.groupHeader}>
        <h2 className={styles.groupTitle} data-testid={`group-title-${group.label}`}>
          {group.label}
        </h2>
        <span className={styles.groupCount} data-testid={`group-count-${group.label}`}>
          {group.items.length}
        </span>
      </div>

      <div className={styles.cardList}>
        {group.items.map((work) => (
          <StoryWorkCard key={work.id} work={work} view={view} />
        ))}
      </div>
    </section>
  );
};
