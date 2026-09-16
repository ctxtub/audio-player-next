'use client';

import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { Sparkles, Pause, Headphones } from 'lucide-react';
import type { StoryCardPart } from '@/types/chat';
import { useGenerationStore } from '@/stores/generationStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import { playStoryCard } from '@/app/services/playbackSessionFlow';
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
    messageId,
}) => {
    const [showFullText, setShowFullText] = useState(false);
    const contentRef = useRef<HTMLDivElement>(null);

    // 订阅生成状态，用于展示不同阶段 UI
    const phase = useGenerationStore((state) => state.phase);
    const streamingText = useGenerationStore((state) => state.streamingText);

    // 订阅播放状态（仅按钮态 presentation：同卡 + Transport 正在播 → 展示暂停。
    // 存在性判定永不读 Transport，只看 Session；播放决策永不直调 Transport）。
    const isPlaybackPlaying = usePlaybackStore((state) => state.isPlaying);

    // 订阅断点续播状态（ fixup：经  Session SSOT；Draft 按 messageId 匹配，
    // Work 经 library 精确 resolve，不走旧 progress store / generationHistory 最近 N 条）。
    // 合法未完成断点：next > 0 AND next < total（ended 后 next==total 不得再显示续播；
    // UI 判定与 action 判定同源共用 isThisCardResumePoint）。
    const sessionSource = usePlaybackSessionStore((state) => state.source);
    const sessionNextIndex = usePlaybackSessionStore((state) => state.nextParagraphIndex);
    const sessionTotalParagraphs = usePlaybackSessionStore((state) => state.totalParagraphs);
    const isThisCardResumePoint = Boolean(
        messageId &&
        sessionSource?.kind === 'draft' &&
        sessionSource.messageId === messageId &&
        sessionNextIndex > 0 &&
        sessionNextIndex < sessionTotalParagraphs,
    );

    const isThisCardPlaying = Boolean(
        messageId &&
        sessionSource?.kind === 'draft' &&
        sessionSource.messageId === messageId &&
        isPlaybackPlaying,
    );

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

    /** 处理播放按钮点击（唯一正式入口 playStoryCard；
     * 组件只交稳定 identity + 卡片上下文，不再自维护 resume/audioUrl/playStoryText
     * 播放决策。Legacy part.audioUrl 在此面被有意忽略（无 segment identity，
     * 不得当 paragraph 0 播放；identity/segmentation 正确 > 复用旧音频缓存）。 */
    const handlePlay = () => {
        if (!messageId) return;
        void playStoryCard({ messageId, storyText: part.storyText }).catch(() => {
            // Flow fail-closed（无正文/server 拒绝等）：保持按钮态，不抛。
        });
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
                        {isThisCardPlaying ? (
                            <><Pause size={14} strokeWidth={2} /> 暂停播放</>
                        ) : isThisCardResumePoint ? (
                            <><Headphones size={14} strokeWidth={2} /> 从第 {sessionNextIndex + 1} 段继续收听</>
                        ) : (
                            <><Headphones size={14} strokeWidth={2} /> 播放故事</>
                        )}
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
