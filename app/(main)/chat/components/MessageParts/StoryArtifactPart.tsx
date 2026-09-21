'use client';

import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { Loader2, Pause, Play, RotateCcw, RotateCw, Sparkles } from 'lucide-react';
import type { StoryArtifactPart } from '@/types/chat';
import { useChatStore } from '@/stores/chatStore';
import { usePlaybackIntentStore } from '@/stores/playbackIntentStore';
import { isValidWorkId } from '@/lib/playback/source';
import StoryViewer from '@/app/(main)/chat/components/StoryViewer';
import {
  useStoryArtifactPlaybackViewModel,
  type StoryArtifactPlaybackIcon,
} from './useStoryArtifactPlayback';
import type { PartRendererProps } from './index';
import styles from './index.module.scss';

/** 故事预览的最大字符数。 */
const PREVIEW_MAX_LENGTH = 100;

/** 主操作图标（展示层据 ViewModel 图标语义选择，不进业务分支）。 */
const ACTION_ICONS: Record<StoryArtifactPlaybackIcon, typeof Play> = {
  play: Play,
  pause: Pause,
  retry: RotateCw,
  restart: RotateCcw,
  loading: Loader2,
};

/**
 * Modern 故事 Artifact 片段渲染器。
 *
 * 纯 ChatArtifact lifecycle UI：唯一状态源是 `artifact.status`
 *（draft → complete → promoting → ready / promotion_failed，draft → interrupted）。
 * - 正文只读 `artifact.storyText`，绝不回退读全局生成暂存；
 * - ready 且持有合法 `storyWorkId` 时显示正式播放主操作（状态与进度经
 *   `useStoryArtifactPlaybackViewModel` 从共享 Session/Transport 纯派生，
 *   当前卡判定只看 `source.workId === storyWorkId`）；
 * - ready 不再出现作品库 CTA 与 `/library/:workId` 链接，保存成功只保留
 *   状态行弱提示，不占据主操作位；
 * - promotion_failed 重试只 dispatch `{ type: 'promotion.retry', messageId }`（fail-closed）；
 * - Draft/promoting/promotion_failed 保留原有生成/保存语义，未形成 Work 的
 *   内容不进入正式 Work 播放路径；
 * - 播放失败只在对应卡片显示状态文案，不暴露内部错误码；
 * - 不推导、不改写 ChatMessage delivery 状态。
 */
const StoryArtifactPartRenderer: FC<PartRendererProps<StoryArtifactPart>> = ({
  part,
  messageId,
}) => {
  const [showFullText, setShowFullText] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const dispatch = useChatStore((state) => state.dispatch);
  const autoplayPending = usePlaybackIntentStore(
    (state) => Boolean(messageId) && state.pendingAutoplayMessageId === messageId,
  );

  const artifact = part.artifact;
  const status = artifact.status;
  const isDraft = status === 'draft';

  // ready 必须携带合法 storyWorkId（领域契约）；非法时不渲染播放入口（fail-closed）。
  const readyWorkId =
    status === 'ready' && isValidWorkId(artifact.storyWorkId) ? artifact.storyWorkId : null;

  // 播放 ViewModel：非 ready 时传入 null，派生恒为 idle 且主操作不渲染。
  const playback = useStoryArtifactPlaybackViewModel(readyWorkId, { autoplayPending });

  // 正文唯一来源是 Artifact 自身持有，不读全局 generation。
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

  // promotion_failed 重试唯一动作；messageId 缺失时 fail-closed（不猜 latest）。
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
        // 保存成功只用播放区状态行弱提示，不占头部主语义。
        return null;
      case 'promotion_failed':
        return '保存失败，可重试保存';
      case 'interrupted':
        return '生成已中断';
      default:
        return null;
    }
  }, [status]);

  const showRetry = status === 'promotion_failed';
  const showPlayback = readyWorkId !== null;
  const ActionIcon = ACTION_ICONS[playback.actionIcon];

  return (
    <div
      className={`${styles.storyCard} ${showPlayback && playback.state === 'playing' ? styles.playing : ''}`}
    >
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

      {showPlayback && (
        <div className={styles.playbackMeta}>
          <span
            className={`${styles.playbackStatus} ${playback.state === 'error' ? styles.playbackStatusError : ''}`}
            aria-live="polite"
          >
            {playback.statusText}
          </span>
          <span
            className={styles.playbackProgressTrack}
            aria-hidden="true"
          >
            <span
              className={styles.playbackProgressFill}
              style={{ width: playback.progressRatio !== null ? `${Math.round(playback.progressRatio * 100)}%` : '0%' }}
            />
          </span>
        </div>
      )}

      {(needsTruncation || showRetry || showPlayback) && (
        <div className={styles.storyActions}>
          {showPlayback && (
            <button
              type="button"
              className={styles.playButton}
              disabled={playback.disabled}
              aria-label={playback.actionLabel}
              onClick={playback.runPrimary}
            >
              <ActionIcon
                size={14}
                strokeWidth={2}
                className={playback.actionIcon === 'loading' ? styles.spinner : undefined}
                aria-hidden="true"
              />
              {playback.actionLabel}
            </button>
          )}
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
