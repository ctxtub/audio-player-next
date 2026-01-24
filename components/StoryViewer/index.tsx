'use client';

import React, { useMemo } from 'react';
import Modal, { useModal } from '@/components/Modal';
import { useChatStore } from '@/stores/chatStore';
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
  const storyContent = useChatStore((state) => state.getStoryContext().storyContent);
  // 为了兼容旧的段落渲染逻辑，或者更简单的：直接按换行符分割?
  // 之前的 segments 是段落数组。storyContent 是拼接好的字符串。
  // 我们尝试按换行符分割来渲染段落。
  const paragraphs = useMemo(() => {
    if (!storyContent) return [];
    return storyContent.split('\n').filter(p => p.trim() !== '');
  }, [storyContent]);

  const { isShow, showModal, closeModal } = useModal();
  const containerClassName = className
    ? `${styles.storyPreview} ${className}`
    : styles.storyPreview;

  const renderStoryContent = () => (
    <div className={styles.storyText}>
      {paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </div>
  );

  // 预览文本：直接用 storyContent 截断
  const previewText = storyContent ? storyContent.slice(0, 100) : '';

  if (!storyContent) {
    return null;
  }

  return (
    <>
      <div className={containerClassName} onClick={showModal}>
        <p className={styles.storyPreviewText}>{previewText}...</p>
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
