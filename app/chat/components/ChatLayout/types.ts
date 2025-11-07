/**
 * 聊天布局组件的属性定义。
 */
import type { ChatMessage } from '../ChatLog/types';

export interface ChatLayoutProps {
  /** 用户昵称，用于头部信息展示。 */
  userNickname: string;
  /** 会话 ID，可为空用于占位展示。 */
  conversationId: string | null;
  /** 初始消息列表，用于填充默认对话内容。 */
  initialMessages: ChatMessage[];
}
