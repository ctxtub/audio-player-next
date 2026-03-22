'use client';

import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { Sparkles, Pause, Headphones } from 'lucide-react';
import type { StoryCardPart } from '@/types/chat';
import { useGenerationStore } from '@/stores/generationStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import StoryViewer from '@/app/(main)/chat/components/StoryViewer';
import type { PartRendererProps } from './index';
import styles from './index.module.scss';

/** 故事预览的最大字符数。 */
const PREVIEW_MAX_LENGTH = 100;

/**
 * 故事卡片片段渲染器
 *
 * 支持多阶段展示：
 * - generating_text：打字机效果 + 光标闪烁
 * - generating_audio：音波蒙层
 * - ready：文本 + 播放按钮
 */
const StoryCardPartRenderer: FC<PartRendererProps<StoryCardPart>> = ({
    part,
    onPlayStory,
}) => {
    const [showFullText, setShowFullText] = useState(false);
    const contentRef = useRef<HTMLDivElement>(null);

    // 订阅生成状态，用于展示不同阶段 UI
    const phase = useGenerationStore((state) => state.phase);
    const streamingText = useGenerationStore((state) => state.streamingText);

    // 订阅播放状态
    const currentAudioUrl = usePlaybackStore((state) => state.currentAudioUrl);
    const isPlaybackPlaying = usePlaybackStore((state) => state.isPlaying);
    const pauseAudioPlayback = usePlaybackStore((state) => state.pauseAudioPlayback);

    const isThisCardPlaying = isPlaybackPlaying && currentAudioUrl === part.audioUrl;

    // 判断是否处于生成中状态（需要展示动效）
    // 只有当全局处于生成状态，且当前卡片没有音频地址（说明是正在生成的卡片）时，才展示动效
    const isGlobalGenerating = phase === 'generating_text' || phase === 'generating_audio';
    const isGenerating = isGlobalGenerating && !part.audioUrl;

    const isGeneratingText = isGenerating && phase === 'generating_text';
    const isGeneratingAudio = isGenerating && phase === 'generating_audio';

    // 优先使用 part.storyText，因为 chatStore 已经同步了流式内容
    // 仅在生成中且 part.storyText 为空时兜底显示 streamingText (通常不会发生)
    const currentText = part.storyText || (isGenerating ? streamingText : '');

    // 自动滚动到底部（生成中）
    useEffect(() => {
        if (isGenerating && contentRef.current) {
            contentRef.current.scrollTop = contentRef.current.scrollHeight;
        }
    }, [isGenerating, currentText]); // 监听 currentText 变化滚动

    /** 是否需要展开/收起功能（仅在非生成阶段）。 */
    const needsTruncation = useMemo(
        () => !isGenerating && currentText.length > PREVIEW_MAX_LENGTH,
        [isGenerating, currentText],
    );

    /** 展示的故事文本。 */
    const displayText = useMemo(() => {
        // 生成过程中始终展示全文本
        if (isGenerating) {
            return currentText;
        }
        if (!needsTruncation) {
            return currentText;
        }
        // 始终截断
        return `${currentText.slice(0, PREVIEW_MAX_LENGTH)}...`;
    }, [isGenerating, needsTruncation, currentText]);

    /** 处理播放按钮点击。 */
    const handlePlay = () => {
        if (isThisCardPlaying) {
            pauseAudioPlayback();
        } else {
            onPlayStory?.(part.audioUrl);
        }
    };

    /** 打开全文弹窗。 */
    const handleOpenFullText = () => {
        setShowFullText(true);
    };

    /** 关闭全文弹窗。 */
    const handleCloseFullText = () => {
        setShowFullText(false);
    };

    /** 获取状态头部文案。 */
    const headerText = useMemo(() => {
        if (isGeneratingText) return '正在创作故事...';
        if (isGeneratingAudio) return '正在生成语音...';
        return null;
    }, [isGeneratingText, isGeneratingAudio]);

    return (
        <div className={`${styles.storyCard} ${isThisCardPlaying ? styles.playing : ''}`}>
            {/* 生成中的状态头部 */}
            {isGenerating && (
                <div className={styles.storyHeader}>
                    <Sparkles size={16} strokeWidth={2} className={styles.sparkle} />
                    <span>{headerText}</span>
                </div>
            )}

            {/* 内容区域 */}
            <div
                ref={contentRef}
                className={`${styles.storyContent} ${isGenerating ? styles.storyContentGenerating : ''}`}
            >
                <p className={styles.storyText}>
                    {displayText}
                    {isGeneratingText && <span className={styles.cursor}>|</span>}
                </p>
            </div>

            {/* 音频生成中的蒙层 */}
            {isGeneratingAudio && (
                <div className={styles.audioOverlay}>
                    <div className={styles.bars}>
                        {[...Array(5)].map((_, i) => (
                            <div
                                key={i}
                                className={styles.bar}
                                style={{ animationDelay: `${i * 0.1}s` }}
                            />
                        ))}
                    </div>
                </div>
            )}

            {/* 完成状态的操作区 */}
            {!isGenerating && (
                <div className={styles.storyActions}>
                    {needsTruncation && (
                        <button
                            type="button"
                            className={styles.expandButton}
                            onClick={handleOpenFullText}
                        >
                            查看全文
                        </button>
                    )}
                    <button
                        type="button"
                        className={styles.playButton}
                        onClick={handlePlay}
                    >
                        {isThisCardPlaying ? <><Pause size={14} strokeWidth={2} /> 暂停播放</> : <><Headphones size={14} strokeWidth={2} /> 播放故事</>}
                    </button>
                </div>
            )}

            <StoryViewer
                isOpen={showFullText}
                onClose={handleCloseFullText}
                content={currentText}
                title="故事文本"
            />
        </div>
    );
};

export default StoryCardPartRenderer;
