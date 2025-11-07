/**
 * 聊天布局组件的属性定义。
 */
export interface ChatLayoutProps {
  /** 用户昵称，用于顶部栏展示。 */
  userNickname: string;
  /** 会话 ID，可为空用于占位展示。 */
  conversationId: string | null;
}
