"use client";

import React, { useMemo } from "react";
import Modal, { useModal } from "@/components/Modal";
import { useStoryStore } from "@/stores/storyStore";
import { cx } from "@/utils/cx";

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
  const storyText = useMemo(() => storyList.join("\n"), [storyList]);
  const { isShow, showModal, closeModal } = useModal();
  const containerClassName = cx(
    "cursor-pointer rounded-2xl border border-border-card bg-surface p-5 shadow-floating backdrop-blur-panel transition-transform duration-theme ease-theme",
    className,
  );

  const renderStoryContent = () => (
    <div className="space-y-4 p-5 text-base leading-[1.8] text-foreground">
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
        <p className="indent-8 text-base leading-[1.6] text-foreground">
          {storyText.slice(0, 100)}...
        </p>
        <button
          className="mt-md inline-flex items-center border-0 bg-transparent text-sm font-semibold text-primary transition-transform duration-theme ease-theme after:ml-xs after:transition-transform after:duration-theme after:ease-theme after:content-['→'] hover:after:translate-x-0.5"
          type="button"
        >
          查看全文
        </button>
      </div>

      <Modal isShow={isShow} title="故事全文" onClose={closeModal}>
        {renderStoryContent()}
      </Modal>
    </>
  );
};

export default StoryViewer;
