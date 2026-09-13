'use client';

import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { Sparkles } from 'lucide-react';
import type { StoryArtifactPart } from '@/types/chat';
import { useChatStore } from '@/stores/chatStore';
import StoryViewer from '@/app/(main)/chat/components/StoryViewer';
import type { PartRendererProps } from './index';
import styles from './index.module.scss';

/** 故事预览的最大字符数。 */
const PREVIEW_MAX_LENGTH = 100;

/**
 * Modern 故事 Artifact 片段渲染器（M4-05）。
 *
 * 纯 ChatArtifact lifecycle UI：唯一状态源是 `artifact.status`
 *（draft → complete → promoting → ready / promotion_failed，draft → interrupted）。
 * - 正文只读 `artifact.storyText`，绝不回退读全局生成暂存；
 * - 无 playback 预接（无播放/暂停/续播/音频生成语义）；
 * - promotion_failed 重试只 dispatch `{ type: 'promotion.retry', messageId }`（fail-closed）；
 * - ready 只做 Library handoff（导航到 `/library/${storyWorkId}`，不做任何 fetch/播放/mutation）；
 * - 不推导、不改写 ChatMessage delivery 状态。
 */
const StoryArtifactPartRenderer: FC<PartRendererProps<StoryArtifactPart>> = ({
  part,
  messageId,
}) => {
  const [showFullText, setShowFullText] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const dispatch = useChatStore((state) => state.dispatch);

  const artifact = part.artifact;
  const status = artifact.status;
  const isDraft = status === 'draft';

  // M4-05：正文唯一来源是 Artifact 自身持有，不读全局 generation。
  const currentText = artifact.storyText;

  // draft 自动滚动：条件只看 Artifact 自身（status + storyText 变化）。
  useEffect(() => {
    if (isDraft && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [isDraft, currentText]);

  const needsTruncation = useMemo(
    () => !isDraft && currentText.length > PREVIEW_MAX_LENGTH,
    [isDraft, currentText],
  );

  const displayText = useMemo(() => {
    if (isDraft) return currentText;
    if (!needsTruncation) return currentText;
    return `${currentText.slice(0, PREVIEW_MAX_LENGTH)}...`;
  }, [isDraft, needsTruncation, currentText]);

  // M4-05：promotion_failed 重试唯一动作；messageId 缺失时 fail-closed（不猜 latest）。
  const handleRetryPromotion = () => {
    if (!messageId) return;
    dispatch({ type: 'promotion.retry', messageId });
  };

  const headerText = useMemo(() => {
    switch (status) {
      case 'draft':
        return '正在创作故事';
      case 'complete':
        return '故事正文已完成，准备保存';
      case 'promoting':
        return '正在保存到作品库';
      case 'ready':
        return '已保存到作品库';
      case 'promotion_failed':
        return '保存失败，可重试保存';
      case 'interrupted':
        return '生成已中断';
      default:
        return null;
    }
  }, [status]);

  const showRetry = status === 'promotion_failed';
  // ready 必须携带正整数 storyWorkId（领域契约）；非正整数时不渲染 CTA（fail-closed，只导航）。
  const readyWorkId = status === 'ready' ? artifact.storyWorkId : undefined;
  const showLibraryCta = typeof readyWorkId === 'number' && Number.isInteger(readyWorkId) && readyWorkId > 0;

  return (
    <div className={styles.storyCard}>
      {headerText && (
        <div className={styles.storyHeader}>
          <Sparkles size={16} strokeWidth={2} className={styles.sparkle} />
          <span>{headerText}</span>
        </div>
      )}

      <div
        ref={contentRef}
        className={`${styles.storyContent} ${isDraft ? styles.storyContentGenerating : ''}`}
      >
        <p className={styles.storyText}>
          {displayText}
          {isDraft && <span className={styles.cursor}>|</span>}
        </p>
      </div>

      {(needsTruncation || showRetry || showLibraryCta) && (
        <div className={styles.storyActions}>
          {needsTruncation && (
            <button
              type="button"
              className={styles.expandButton}
              onClick={() => setShowFullText(true)}
            >
              查看全文
            </button>
          )}
          {showRetry && (
            <button
              type="button"
              className={styles.retryButton}
              onClick={handleRetryPromotion}
            >
              重试保存
            </button>
          )}
          {showLibraryCta && (
            <a
              className={styles.libraryLink}
              href={`/library/${readyWorkId}`}
            >
              查看作品
            </a>
          )}
        </div>
      )}

      <StoryViewer
        isOpen={showFullText}
        onClose={() => setShowFullText(false)}
        content={currentText}
        title="故事文本"
      />
    </div>
  );
};

export default StoryArtifactPartRenderer;
