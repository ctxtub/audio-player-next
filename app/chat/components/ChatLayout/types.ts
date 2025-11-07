/**
 * 聊天布局组件的属性定义。
 */
import type { ChatMessage } from '../ChatLog/types';

export interface ChatLayoutProps {
  /** 初始消息列表，用于填充默认对话内容。 */
  initialMessages: ChatMessage[];
}
