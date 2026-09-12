'use client';

import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { Sparkles, Pause, Headphones } from 'lucide-react';
import type { StoryArtifactPart } from '@/types/chat';
import { useGenerationStore } from '@/stores/generationStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { usePlaybackProgressStore } from '@/stores/playbackProgressStore';
import { playStoryText } from '@/app/services/storyFlow';
import StoryViewer from '@/app/(main)/chat/components/StoryViewer';
import type { PartRendererProps } from './index';
import styles from './index.module.scss';

/** 故事预览的最大字符数。 */
const PREVIEW_MAX_LENGTH = 100;

/**
 * Modern 故事 Artifact 片段渲染器（M4-02）。
 * 只读渲染 draft/complete/interrupted 正文；绝不读写 audioUrl（Modern Artifact 无该字段），
 * 播放经正文重合成（playStoryText），与 Legacy StoryCard 渲染并存（历史只读）。
 */
const StoryArtifactPartRenderer: FC<PartRendererProps<StoryArtifactPart>> = ({
  part,
  messageId,
}) => {
  const [showFullText, setShowFullText] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const phase = useGenerationStore((state) => state.phase);
  const streamingText = useGenerationStore((state) => state.streamingText);
  const isPlaybackPlaying = usePlaybackStore((state) => state.isPlaying);
  const pauseAudioPlayback = usePlaybackStore((state) => state.pauseAudioPlayback);
  const activeProgressSourceId = usePlaybackProgressStore((state) => state.sourceId);
  const activeNextIndex = usePlaybackProgressStore((state) => state.nextParagraphIndex);

  const artifact = part.artifact;
  const status = artifact.status;
  const isDraft = status === 'draft';
  const isInterrupted = status === 'interrupted';

  const isThisCardPlaying =
    isPlaybackPlaying && activeProgressSourceId === messageId && isPlaybackPlaying;
  const isThisCardResumePoint = Boolean(
    messageId && activeProgressSourceId === messageId && activeNextIndex > 0,
  );

  const isGlobalGenerating = phase === 'generating_text' || phase === 'generating_audio';
  const isGenerating = isGlobalGenerating && isDraft;

  const isGeneratingText = isGenerating && phase === 'generating_text';
  const isGeneratingAudio = isGenerating && phase === 'generating_audio';

  const currentText = artifact.storyText || (isGenerating ? streamingText : '');

  useEffect(() => {
    if (isGenerating && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [isGenerating, currentText]);

  const needsTruncation = useMemo(
    () => !isGenerating && currentText.length > PREVIEW_MAX_LENGTH,
    [isGenerating, currentText],
  );

  const displayText = useMemo(() => {
    if (isGenerating) return currentText;
    if (!needsTruncation) return currentText;
    return `${currentText.slice(0, PREVIEW_MAX_LENGTH)}...`;
  }, [isGenerating, needsTruncation, currentText]);

  const handlePlay = () => {
    if (isThisCardPlaying) {
      pauseAudioPlayback();
      return;
    }
    if (currentText) {
      void playStoryText(currentText, messageId);
    }
  };

  const headerText = useMemo(() => {
    if (isInterrupted) return '生成已中断';
    if (isGeneratingText) return '正在创作故事...';
    if (isGeneratingAudio) return '正在生成语音...';
    if (isDraft) return '正在创作故事...';
    return null;
  }, [isInterrupted, isGeneratingText, isGeneratingAudio, isDraft]);

  return (
    <div className={`${styles.storyCard} ${isThisCardPlaying ? styles.playing : ''}`}>
      {(isGenerating || isInterrupted || (isDraft && headerText)) && (
        <div className={styles.storyHeader}>
          <Sparkles size={16} strokeWidth={2} className={styles.sparkle} />
          <span>{headerText}</span>
        </div>
      )}

      <div
        ref={contentRef}
        className={`${styles.storyContent} ${isGenerating ? styles.storyContentGenerating : ''}`}
      >
        <p className={styles.storyText}>
          {displayText}
          {isGeneratingText && <span className={styles.cursor}>|</span>}
        </p>
      </div>

      {isGeneratingAudio && (
        <div className={styles.audioOverlay}>
          <div className={styles.bars}>
            {[...Array(5)].map((_, i) => (
              <div key={i} className={styles.bar} style={{ animationDelay: `${i * 0.1}s` }} />
            ))}
          </div>
        </div>
      )}

      {!isGenerating && !isInterrupted && currentText && (
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
          <button type="button" className={styles.playButton} onClick={handlePlay}>
            {isThisCardPlaying ? (
              <><Pause size={14} strokeWidth={2} /> 暂停播放</>
            ) : isThisCardResumePoint ? (
              <><Headphones size={14} strokeWidth={2} /> 从第 {activeNextIndex + 1} 段继续收听</>
            ) : (
              <><Headphones size={14} strokeWidth={2} /> 播放故事</>
            )}
          </button>
        </div>
      )}

      {isInterrupted && (
        <div className={styles.storyActions}>
          <span>生成未完成，可重试</span>
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
