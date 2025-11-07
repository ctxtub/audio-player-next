import type { ReactNode } from 'react';

/**
 * 聊天消息支持的角色类型，区分系统提示、助手回复与用户输入。
 */
export type ChatMessageRole = 'system' | 'assistant' | 'user';

/**
 * 聊天消息的投递状态，用于渲染发送中或失败的视觉反馈。
 */
export type ChatMessageDeliveryStatus = 'delivered' | 'sending' | 'failed';

/**
 * 已写入消息列表的标准消息结构体，包含角色、内容与可选状态。
 */
export type ChatMessage = {
  /** 唯一标识符，通常来自后端或 store。 */
  id: string;
  /** 消息的发布角色，影响左右对齐。 */
  role: ChatMessageRole;
  /** 文本内容，支持多行展示。 */
  content: string;
  /** 投递状态，未提供时默认为已发送成功。 */
  status?: ChatMessageDeliveryStatus;
  /** 消息创建时间，可用于排序或显示。 */
  createdAt?: string;
};

/**
 * 待发送或等待重试的临时消息结构，可能尚未生成服务端 id。
 */
export type ChatPendingMessage = {
  /** 临时 id，用于与失败状态的消息做关联。 */
  id?: string;
  /** 用户或助手角色，系统消息不经过待发送阶段。 */
  role: Exclude<ChatMessageRole, 'system'>;
  /** 文本内容，通常来自输入框。 */
  content: string;
  /** 投递状态，限定在发送中或失败两种状态。 */
  status?: Extract<ChatMessageDeliveryStatus, 'sending' | 'failed'>;
};

/**
 * ChatLog 组件的入参定义，供外部页面或容器组件使用。
 */
export type ChatLogProps = {
  /** 消息列表，按时间顺序排列。 */
  messages: ChatMessage[];
  /** 待发送消息，用于在列表末尾展示发送进度。 */
  pendingMessage?: ChatPendingMessage | null;
  /** 是否展示加载状态，用于历史记录加载过程。 */
  isLoading?: boolean;
  /** 自定义空状态文案或插画。 */
  emptyHint?: ReactNode;
  /** 自定义加载状态内容。 */
  loadingHint?: ReactNode;
  /** 失败消息重试回调，传入消息 id。 */
  onRetry?: (messageId?: string) => void;
  /** 自定义外层容器的 className。 */
  className?: string;
};
