'use client';

import React from 'react';
import { useGenerationStore } from '@/stores/generationStore';
import styles from './index.module.scss';

/**
 * 音波动画组件
 *
 * 在音频生成阶段展示动态音波效果。
 */
const AudioWaveAnimation: React.FC = () => {
    const phase = useGenerationStore((state) => state.phase);

    if (phase !== 'generating_audio') {
        return null;
    }

    return (
        <div className={styles.waveContainer}>
            <div className={styles.bars}>
                {[...Array(5)].map((_, i) => (
                    <div key={i} className={styles.bar} style={{ animationDelay: `${i * 0.1}s` }} />
                ))}
            </div>
            <p className={styles.text}>正在生成语音...</p>
        </div>
    );
};

export default AudioWaveAnimation;
