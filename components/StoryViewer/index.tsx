'use client';

import React, { useMemo } from 'react';
import Modal, { useModal } from '@/components/Modal';
import { useStoryStore } from '@/stores/storyStore';
import styles from './index.module.scss';

/**
 * 故事展示组件的入参定义。
 */
interface StoryViewerProps {
  /** 外层自定义类名 */
  className?: string;
}

/**
 * 故事展示组件，支持预览与弹窗阅读全文。
 */
const StoryViewer: React.FC<StoryViewerProps> = ({ className }) => {
  const storyList = useStoryStore((state) => state.segments);
  const storyText = useMemo(() => storyList.join('\n'), [storyList]);
  const { isShow, showModal, closeModal } = useModal();
  const containerClassName = className
    ? `${styles.storyPreview} ${className}`
    : styles.storyPreview;
  
  const renderStoryContent = () => (
    <div className={styles.storyText}>
      {storyList.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </div>
  );
  
  if (!storyList.length) {
    return null;
  }

  return (
    <>
      <div className={containerClassName} onClick={showModal}>
        <p className={styles.storyPreviewText}>{storyText.slice(0, 100)}...</p>
        <button className={styles.readMore}>查看全文</button>
      </div>

      <Modal
        isShow={isShow}
        title="故事全文"
        onClose={closeModal}
      >
        {renderStoryContent()}
      </Modal>
    </>
  );
};

export default StoryViewer;
