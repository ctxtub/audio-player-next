import type { ReactNode } from 'react';

import type { ChatMessage, ChatPendingMessage } from '@/types/chat';

/**
 * ChatLog 组件的入参定义，供外部页面或容器组件使用。
 */
export type ChatLogProps = {
  /** 消息列表，按时间顺序排列。 */
  messages: ChatMessage[];
  /** 是否展示加载状态，用于历史记录加载过程。 */
  isLoading?: boolean;
  /** 自定义空状态文案或插画。 */
  emptyHint?: ReactNode;
  /** 自定义加载状态内容。 */
  loadingHint?: ReactNode;
  /** 失败消息重试回调，传入消息 id。 */
  onRetry?: (messageId?: string) => void;
  /** 故事播放回调，由故事卡片触发。 */
  onPlayStory?: (audioUrl: string, messageId: string) => void;
  /** 自定义外层容器的 className。 */
  className?: string;
};

export type { ChatMessage, ChatPendingMessage };
