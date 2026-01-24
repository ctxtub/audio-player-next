import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * 聊天消息支持的角色类型，兼容系统、用户与助手三种身份。
 */
export type ChatMessageRole = ChatCompletionMessageParam['role'];

/**
 * 聊天消息的投递状态，用于区分发送中、失败与已送达。
 */
export type ChatMessageDeliveryStatus = 'delivered' | 'sending' | 'failed';

/**
 * 聊天回复附带的 token 统计，来源于上游 OpenAI usage 字段。
 */
export type ChatUsageSummary = {
  /** 提示词使用的 token 数量。 */
  promptTokens?: number;
  /** 生成内容使用的 token 数量。 */
  completionTokens?: number;
  /** 提示词与生成内容的 token 总数。 */
  totalTokens?: number;
};

/**
 * 聊天消息的元数据，记录结束原因与 token 统计。
 */
export type ChatMessageMetadata = {
  /** OpenAI 返回的 finish_reason。 */
  finishReason?: string;
  /** OpenAI 返回的 token 统计。 */
  usage?: ChatUsageSummary;
};

// ============================================================================
// 消息片段类型系统（Message Parts）
// 采用联合类型实现可扩展的消息内容结构，新增类型只需扩展此联合
// ============================================================================

/**
 * 文本片段，用于普通对话消息。
 */
export type TextPart = {
  /** 片段类型标识。 */
  type: 'text';
  /** 文本内容。 */
  content: string;
};

/**
 * 故事卡片片段，用于故事生成消息，包含故事文本与音频地址。
 */
export type StoryCardPart = {
  /** 片段类型标识。 */
  type: 'storyCard';
  /** 故事文本内容。 */
  storyText: string;
  /** 生成的音频地址。 */
  audioUrl: string;
};

/**
 * 消息片段联合类型，支持多种消息内容形态。
 * 扩展时在此添加新的片段类型。
 */
export type MessagePart = TextPart | StoryCardPart;

/**
 * 类型守卫：判断片段是否为文本类型。
 */
export const isTextPart = (part: MessagePart): part is TextPart =>
  part.type === 'text';

/**
 * 类型守卫：判断片段是否为故事卡片类型。
 */
export const isStoryCardPart = (part: MessagePart): part is StoryCardPart =>
  part.type === 'storyCard';

/**
 * 从消息片段数组中提取纯文本内容，用于上下文传递。
 * @param parts 消息片段数组
 * @returns 拼接后的文本内容
 */
export const extractTextFromParts = (parts: MessagePart[]): string =>
  parts
    .map((part) => {
      if (isTextPart(part)) return part.content;
      if (isStoryCardPart(part)) return part.storyText;
      return '';
    })
    .join('');

/**
 * 会话中已确认的消息结构体，包含内容、角色与可选状态。
 */
export type ChatMessage = {
  /** 唯一标识符，通常由前端临时生成或服务端返回。 */
  id: string;
  /** 消息的角色身份，影响展示位置。 */
  role: ChatMessageRole;
  /**
   * 文本内容，用于向后兼容和上下文传递。
   * 渲染时优先使用 parts，若 parts 不存在则回退到 content。
   */
  content: string;
  /**
   * 消息片段数组，支持多种内容形态（文本、故事卡片等）。
   * 新消息应使用 parts 替代 content。
   */
  parts?: MessagePart[];
  /** 消息状态，未设置时视为已成功送达。 */
  status?: ChatMessageDeliveryStatus;
  /** 消息创建时间戳，ISO 字符串格式。 */
  createdAt?: string;
  /** 展示使用的昵称，默认基于角色生成。 */
  displayName?: string;
  /** 展示使用的头像地址，默认基于角色生成。 */
  avatar?: string;
  /** 额外元数据，例如结束原因与 token 统计。 */
  metadata?: ChatMessageMetadata;
};

/**
 * 待发送或等待重试的消息结构，用于本地占位与状态反馈。
 */
export type ChatPendingMessage = {
  /** 临时 id，用于和失败消息、重试操作建立关联。 */
  id?: string;
  /** 消息角色，仅代表待发送的用户消息。 */
  role: 'user';
  /** 文本内容，通常来自输入框。 */
  content: string;
  /** 消息片段数组，与 ChatMessage 保持一致。 */
  parts?: MessagePart[];
  /** 当前投递状态，仅支持发送中与失败。 */
  status?: Extract<ChatMessageDeliveryStatus, 'sending' | 'failed'>;
  /** 创建时间戳，供展示和排序使用。 */
  createdAt?: string;
  /** 展示使用的昵称，默认基于角色生成。 */
  displayName?: string;
  /** 展示使用的头像地址，默认基于角色生成。 */
  avatar?: string;
};

/**
 * 聊天流式消息事件，包含增量文本片段。
 */
export type ChatStreamMessageEvent = {
  /** 事件类型恒为 message。 */
  type: 'message';
  /** 本次增量的文本内容。 */
  delta: string;
};

/**
 * 聊天流式完成事件，标记助手回复结束。
 */
export type ChatStreamDoneEvent = {
  /** 事件类型恒为 done。 */
  type: 'done';
  /** 上游给出的结束原因，默认 stop。 */
  finishReason: string;
  /** 上游回传的 token 统计，可选字段。 */
  usage?: ChatUsageSummary;
};

/**
 * 聊天流式错误事件，包含错误码与描述。
 */
export type ChatStreamErrorEvent = {
  /** 事件类型恒为 error。 */
  type: 'error';
  /** 业务错误码，便于区分异常场景。 */
  code: string;
  /** 具体的错误描述信息。 */
  message: string;
};

/**
 * 聊天流式事件联合类型，涵盖 message/done/error 三种事件。
 */
export type ChatStreamEvent =
  | ChatStreamMessageEvent
  | ChatStreamDoneEvent
  | ChatStreamErrorEvent;

/**
 * Chat BFF 请求体的结构定义，复用 OpenAI ChatCompletionMessageParam。
 */
export type ChatCompletionPayload = {
  /** 选用的模型名称，前端可选指定。 */
  model?: string;
  /** 对话上下文消息数组，至少包含一条用户消息。 */
  messages: ChatConversationMessage[];
  /** 采样温度，可选字段。 */
  temperature?: number;
  /** nucleus sampling 阈值，可选字段。 */
  top_p?: number;
  /** 生成的最大 token 数，可选字段。 */
  max_tokens?: number;
};

/**
 * 对话上下文中使用的消息类型别名，便于 store 复用。
 */
export type ChatConversationMessage = Extract<
  ChatCompletionMessageParam,
  { role: 'system' | 'user' | 'assistant' }
>;
