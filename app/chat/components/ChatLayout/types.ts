import type { ChatMessage } from '@/types/chat';

/**
 * 聊天布局组件的属性定义。
 */
export interface ChatLayoutProps {
  /** 初始消息列表，用于填充默认对话内容。 */
  initialMessages: ChatMessage[];
}
