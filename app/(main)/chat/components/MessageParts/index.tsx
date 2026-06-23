'use client';

import type { FC } from 'react';
import type { MessagePart } from '@/types/chat';
import TextPartRenderer from './TextPart';
import StoryCardPartRenderer from './StoryCardPart';
import { GuidancePartComponent } from './GuidancePart';
import SummaryPartRenderer from './SummaryPart';

/**
 * 片段渲染器的通用 Props 定义。
 */
export type PartRendererProps<T extends MessagePart = MessagePart> = {
    /** 待渲染的消息片段。 */
    part: T;
    /** 可选的播放故事回调，由 StoryCardPart 使用。 */
    onPlayStory?: (audioUrl: string) => void;
};

/**
 * 消息片段分发器，按 part.type 判别联合分发到对应渲染器。
 * 用 switch 让每个分支自动收窄 part 的具体子类型，无需注册表的 any 断言。
 * @param props.part 待渲染的消息片段
 * @param props.onPlayStory 故事播放回调
 */
const MessagePartRenderer: FC<PartRendererProps> = ({ part, onPlayStory }) => {
    switch (part.type) {
        case 'text':
            return <TextPartRenderer part={part} onPlayStory={onPlayStory} />;
        case 'storyCard':
            return <StoryCardPartRenderer part={part} onPlayStory={onPlayStory} />;
        case 'guidance':
            return <GuidancePartComponent part={part} />;
        case 'summary':
            return <SummaryPartRenderer part={part} />;
        default:
            // 未知类型降级为空
            return null;
    }
};

export default MessagePartRenderer;
