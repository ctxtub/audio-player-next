'use client';

import type { FC } from 'react';
import type { MessagePart } from '@/types/chat';
import TextPartRenderer from './TextPart';
import StoryCardPartRenderer from './StoryCardPart';
import StoryArtifactPartRenderer from './StoryArtifactPart';
import { GuidancePartComponent } from './GuidancePart';
import SummaryPartRenderer from './SummaryPart';

/**
 * 片段渲染器的通用 Props 定义。
 *：onPlayStory Transport 回调已删除——StoryCard 播放 ownership 收口至
 * PlaybackSessionFlow.playStoryCard，组件只收 messageId。
 */
export type PartRendererProps<T extends MessagePart = MessagePart> = {
    /** 待渲染的消息片段。 */
    part: T;
    /** 关联的真实消息 ID。 */
    messageId?: string;
};

/**
 * 消息片段分发器，按 part.type 判别联合分发到对应渲染器。
 * 用 switch 让每个分支自动收窄 part 的具体子类型，无需注册表的 any 断言。
 * @param props.part 待渲染的消息片段
 * @param props.messageId 关联消息 ID
 */
const MessagePartRenderer: FC<PartRendererProps> = ({ part, messageId }) => {
    switch (part.type) {
        case 'text':
            return <TextPartRenderer part={part} />;
        case 'storyCard':
            return <StoryCardPartRenderer part={part} messageId={messageId} />;
        case 'storyArtifact':
            //：Modern StoryArtifact 为纯 lifecycle UI，不再接收 playback 回调；
            return <StoryArtifactPartRenderer part={part} messageId={messageId} />;
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
