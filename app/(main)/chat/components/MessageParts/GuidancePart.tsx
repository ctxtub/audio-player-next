import React from 'react';
import styles from './GuidancePart.module.scss';
import type { GuidancePart } from '@/types/chat';

interface GuidancePartProps {
    part: GuidancePart;
}

export const GuidancePartComponent: React.FC<GuidancePartProps> = ({ part }) => {
    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.titleGroup}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.terminalIcon}><polyline points="4 17 10 11 4 5" /><line x1="12" x2="20" y1="19" y2="19" /></svg>
                    <span>SYSTEM_INSTRUCTION</span>
                </div>
            </div>
            <div className={styles.content}>
                {`> ${part.content}`}
            </div>
            <div className={styles.footer}>
                <div className={styles.status}>
                    <span>WAITING_FOR_CONFIRMATION</span>
                    <span className={styles.cursor}></span>
                </div>
            </div>
        </div>
    );
};
