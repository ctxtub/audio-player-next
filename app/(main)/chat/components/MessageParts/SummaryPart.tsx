
import { useState, type FC } from 'react';
import { FileText } from 'lucide-react';
import type { SummaryPart } from '@/types/chat';
import StoryViewer from '@/app/(main)/chat/components/StoryViewer';
import styles from './index.module.scss';

type SummaryPartRendererProps = {
    part: SummaryPart;
};

const SummaryPartRenderer: FC<SummaryPartRendererProps> = ({ part }) => {
    const [showFull, setShowFull] = useState(false);
    const content = part.content;
    const MAX_LENGTH = 60;

    const shouldTruncate = content.length > MAX_LENGTH;
    const displayText = shouldTruncate ? `${content.slice(0, MAX_LENGTH)}...` : content;

    const handleClick = () => {
        if (shouldTruncate) {
            setShowFull(true);
        }
    };

    return (
        <>
            <div
                className={`${styles.summaryContainer} ${shouldTruncate ? styles.clickable : ''}`}
                onClick={handleClick}
            >
                <div className={styles.summaryIcon}><FileText size={20} strokeWidth={1.8} /></div>
                <div className={styles.summaryContent}>
                    <div className={styles.summaryTitle}>上下文总结</div>
                    <div className={styles.summaryText}>{displayText}</div>
                </div>
            </div>

            <StoryViewer
                isOpen={showFull}
                onClose={() => setShowFull(false)}
                content={content}
                title="摘要文本"
            />
        </>
    );
};

export default SummaryPartRenderer;
