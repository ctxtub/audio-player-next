'use client';

import React, { useMemo } from 'react';
import Modal, { useModal } from '@/components/Modal';
import { useStoryStore } from '@/stores/storyStore';
import { cx } from '@/utils/cx';

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
  const containerClassName = cx(
    'cursor-pointer rounded-2xl border border-[var(--card-border)] bg-[var(--card-background)] p-5 shadow-[0_8px_16px_var(--shadow-color)] backdrop-blur-[var(--blur-radius)] transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)]',
    className
  );

  const renderStoryContent = () => (
    <div className="space-y-4 p-5 text-[16px] leading-[1.8] text-[var(--foreground)]">
      {storyList.map((paragraph, index) => (
        <p key={index} className="indent-8">
          {paragraph}
        </p>
      ))}
    </div>
  );
  
  if (!storyList.length) {
    return null;
  }

  return (
    <>
      <div className={containerClassName} onClick={showModal}>
        <p className="text-[16px] leading-[1.6] text-[var(--foreground)] indent-8">{storyText.slice(0, 100)}...</p>
        <button
          className="mt-[15px] inline-flex items-center border-0 bg-transparent text-sm font-semibold text-[var(--primary)] transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)] after:ml-[5px] after:content-['→'] after:transition-transform after:duration-[var(--transition-speed)] after:ease-[var(--transition-timing)] hover:after:translate-x-[3px]"
          type="button"
        >
          查看全文
        </button>
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
