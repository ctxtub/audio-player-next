'use client';

import type { FC } from 'react';
import type { TextPart } from '@/types/chat';
import type { PartRendererProps } from './index';
import styles from './index.module.scss';

/**
 * 文本片段渲染器，用于普通对话消息。
 */
const TextPartRenderer: FC<PartRendererProps<TextPart>> = ({ part }) => {
    return <span className={styles.textPart}>{part.content}</span>;
};

export default TextPartRenderer;
