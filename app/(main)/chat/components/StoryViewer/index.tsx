'use client';

import React, { useMemo } from 'react';
import Modal from '@/components/Modal';
import styles from './index.module.scss';

export interface StoryViewerProps {
  /** 是否展示全文弹窗 */
  isOpen: boolean;
  /** 关闭弹窗的回调 */
  onClose: () => void;
  /** 文本内容 */
  content: string;
  /** 弹窗标题 */
  title?: string;
}

/**
 * 文本展示弹窗组件（弹窗）。
 */
const StoryViewer: React.FC<StoryViewerProps> = ({ isOpen, onClose, content, title = '文本内容' }) => {
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
      title={title}
      onClose={onClose}
    >
      {renderStoryContent()}
    </Modal>
  );
};

export default StoryViewer;
