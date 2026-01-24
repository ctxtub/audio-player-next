'use client';

import type { FC } from 'react';
import type { MessagePart } from '@/types/chat';
import TextPartRenderer from './TextPart';
import StoryCardPartRenderer from './StoryCardPart';

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
 * 渲染器注册表，根据片段类型映射到对应的渲染组件。
 * 使用 any 类型绕过泛型协变问题，在分发器中进行类型断言。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const partRenderers: Record<string, FC<any>> = {
    text: TextPartRenderer,
    storyCard: StoryCardPartRenderer,
};

/**
 * 消息片段分发器，根据 part.type 自动选择渲染器。
 * @param props.part 待渲染的消息片段
 * @param props.onPlayStory 故事播放回调
 */
const MessagePartRenderer: FC<PartRendererProps> = ({ part, onPlayStory }) => {
    const Renderer = partRenderers[part.type];
    if (!Renderer) {
        // 未知类型降级为空
        return null;
    }
    return <Renderer part={part} onPlayStory={onPlayStory} />;
};

export default MessagePartRenderer;
