import React from 'react';
import { Sparkles } from 'lucide-react';
import styles from './GuidancePart.module.scss';
import type { GuidancePart } from '@/types/chat';

interface GuidancePartProps {
  part: GuidancePart;
}

export const GuidancePartComponent: React.FC<GuidancePartProps> = ({ part }) => (
  <div className={styles.container}>
    <div className={styles.header}>
      <div className={styles.titleGroup}>
        <Sparkles size={16} aria-hidden="true" />
        <span>创作指引</span>
      </div>
    </div>
    <div className={styles.content}>{part.content}</div>
    <div className={styles.footer}>创作方向参考</div>
  </div>
);
