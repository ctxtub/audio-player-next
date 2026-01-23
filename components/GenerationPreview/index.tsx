'use client';

import React, { useRef, useEffect } from 'react';
import { useGenerationStore } from '@/stores/generationStore';
import styles from './index.module.scss';

/**
 * 生成预览组件
 *
 * 统一展示文本生成（打字机效果）和音频生成（音波蒙层）的 UI。
 * 在音频生成阶段，文字内容保持可见，上方叠加半透明蒙层和音波动画。
 */
const GenerationPreview: React.FC = () => {
    const phase = useGenerationStore((state) => state.phase);
    const streamingText = useGenerationStore((state) => state.streamingText);
    const contentRef = useRef<HTMLDivElement>(null);

    // 自动滚动到底部
    useEffect(() => {
        if (contentRef.current) {
            contentRef.current.scrollTop = contentRef.current.scrollHeight;
        }
    }, [streamingText]);

    // 仅在生成阶段显示（文本或音频）
    const isVisible = phase === 'generating_text' || phase === 'generating_audio';
    if (!isVisible || !streamingText) {
        return null;
    }

    const isGeneratingAudio = phase === 'generating_audio';

    return (
        <div className={styles.previewContainer}>
            {/* 头部状态指示 */}
            <div className={styles.header}>
                <span className={styles.sparkle}>✦</span>
                <span>{isGeneratingAudio ? '正在生成语音...' : '正在创作故事...'}</span>
            </div>

            {/* 文本内容区域 */}
            <div className={styles.content} ref={contentRef}>
                <p className={styles.text}>
                    {streamingText}
                    {!isGeneratingAudio && <span className={styles.cursor}>|</span>}
                </p>
            </div>

            {/* 音频生成时的蒙层和音波动画 */}
            {isGeneratingAudio && (
                <div className={styles.audioOverlay}>
                    <div className={styles.bars}>
                        {[...Array(5)].map((_, i) => (
                            <div key={i} className={styles.bar} style={{ animationDelay: `${i * 0.1}s` }} />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default GenerationPreview;
