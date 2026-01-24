import React from 'react';
import type { GuidancePart } from '@/types/chat';

interface GuidancePartProps {
    part: GuidancePart;
}

export const GuidancePartComponent: React.FC<GuidancePartProps> = ({ part }) => {
    return (
        <div className='p-4 bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-800 rounded-lg text-sm text-blue-700 dark:text-blue-300 my-2'>
            <div className='font-semibold mb-1 flex items-center gap-2'>
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-lightbulb"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-1 1.5-2.4 1.5-3.8 0-3.2-2.8-6-6-6S6 4.6 6 7.8c0 1.4.6 2.8 1.5 3.8.8.8 1.3 1.5 1.5 2.5" /><path d="M9 18h6" /><path d="M10 22h4" /></svg>
                <span>系统建议</span>
            </div>
            <div className="whitespace-pre-wrap leading-relaxed">
                {part.content}
            </div>
        </div>
    );
};
