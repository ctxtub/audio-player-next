'use client';

import React, { useMemo } from 'react';
import Modal from '@/components/Modal';
import styles from './index.module.scss';

export interface StoryViewerProps {
  /** 是否展示全文弹窗 */
  isOpen: boolean;
  /** 关闭弹窗的回调 */
  onClose: () => void;
  /** 故事全文本内容 */
  content: string;
}

/**
 * 故事全文展示组件（弹窗）。
 */
const StoryViewer: React.FC<StoryViewerProps> = ({ isOpen, onClose, content }) => {
  // 按换行符分割段落
  const paragraphs = useMemo(() => {
    if (!content) return [];
    return content.split('\n').filter(p => p.trim() !== '');
  }, [content]);

  const renderStoryContent = () => (
    <div className={styles.storyText}>
      {paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </div>
  );

  return (
    <Modal
      isShow={isOpen}
      title="故事全文"
      onClose={onClose}
    >
      {renderStoryContent()}
    </Modal>
  );
};

export default StoryViewer;
