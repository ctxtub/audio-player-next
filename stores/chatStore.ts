import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';

import type {
  ChatConversationMessage,
  ChatMessage,
  ChatPendingMessage,
  ChatStreamDoneEvent,
} from '@/types/chat';

/**
 * 聊天 store 的基础状态，记录历史消息与当前请求。
 */
type ChatStoreBaseState = {
  /** 已确认写入的聊天消息列表。 */
  messages: ChatMessage[];
  /** 待发送或等待重试的消息占位。 */
  pendingMessage: ChatPendingMessage | null;
  /** 正在流式拼装的助手消息。 */
  activeAssistantMessage: ChatMessage | null;
  /** 当前在用的 AbortController，支持取消请求。 */
  currentAbortController: AbortController | null;
  /** 已同步到上游的对话上下文。 */
  conversationContext: ChatConversationMessage[];
  /** 输入框中的实时内容，供建议快捷填充。 */
  inputValue: string;
};

/**
 * 聊天 store 暴露的动作集合。
 */
type ChatStoreActions = {
  /** 使用服务端返回的历史记录初始化 store。 */
  hydrateInitialMessages: (initialMessages: ChatMessage[]) => void;
  /** 准备新的消息提交，生成占位消息与上下文。 */
  prepareNewSubmission: (content: string) => ChatSubmissionSnapshot;
  /** 对失败的消息重试，再次生成上下文与助手占位。 */
  prepareRetrySubmission: () => ChatSubmissionSnapshot;
  /** 将助手的流式增量追加到占位消息。 */
  appendAssistantDelta: (delta: string) => void;
  /** 在收到 done 事件后写入消息并刷新上下文。 */
  finalizeAssistantMessage: (payload: ChatStreamDoneEvent) => void;
  /** 流程失败时回退状态并保留失败消息供重试。 */
  markFailure: () => void;
  /** 主动取消时清理占位消息与上下文。 */
  resetActiveSession: () => void;
  /** 记录或清空当前的 AbortController。 */
  setAbortController: (controller: AbortController | null) => void;
  /** 更新输入框的实时内容。 */
  setInputValue: (nextValue: string) => void;
};

/**
 * 聊天 store 的完整类型定义。
 */
export type ChatStore = ChatStoreBaseState & ChatStoreActions;

/**
 * 提交前快照结构，包含用户占位、助手占位及请求上下文。
 */
type ChatSubmissionSnapshot = {
  /** 当前的用户占位消息，用于 UI 展示。 */
  pendingMessage: ChatPendingMessage;
  /** 正在构造的助手占位消息。 */
  assistantMessage: ChatMessage;
  /** 即将发送给上游的对话上下文。 */
  context: ChatConversationMessage[];
};

/**
 * 生成统一格式的时间戳，使用 ISO 字符串表达。
 */
const createTimestamp = () => new Date().toISOString();

/**
 * 生成前缀化的临时消息 id，优先使用 crypto.randomUUID。 
 * @param prefix id 前缀，区分用户或助手。
 */
const createTempMessageId = (prefix: string) => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

/**
 * 支持透传给上游的会话角色列表。
 */
const supportedConversationRoles: ReadonlyArray<ChatConversationMessage['role']> = [
  'system',
  'user',
  'assistant',
];

/**
 * 判断给定角色是否允许透出到会话上下文。
 * @param role 待校验的消息角色。
 */
const isSupportedConversationRole = (
  role: ChatMessage['role'],
): role is ChatConversationMessage['role'] =>
  (supportedConversationRoles as ReadonlyArray<string>).includes(role);

/**
 * 不同角色对应的展示昵称与头像配置。 
 */
const messagePersonaMap: Record<ChatMessage['role'], { displayName: string; avatar: string }> = {
  assistant: {
    displayName: '故事助手',
    avatar: '/icons/avatar-assistant.svg',
  },
  user: {
    displayName: '我',
    avatar: '/icons/avatar-user.svg',
  },
  system: {
    displayName: '系统提示',
    avatar: '/icons/avatar-assistant.svg',
  },
  developer: {
    displayName: '系统提示',
    avatar: '/icons/avatar-assistant.svg',
  },
  function: {
    displayName: '函数输出',
    avatar: '/icons/avatar-assistant.svg',
  },
  tool: {
    displayName: '工具消息',
    avatar: '/icons/avatar-assistant.svg',
  },
};

/**
 * 为消息补全展示用的头像与昵称信息。 
 * @param message 待补全的消息实体。
 */
const withPersona = <T extends ChatMessage | ChatPendingMessage>(message: T): T => {
  const persona = messagePersonaMap[message.role];
  if (!persona) {
    return message;
  }
  return {
    ...message,
    displayName: message.displayName ?? persona.displayName,
    avatar: message.avatar ?? persona.avatar,
  };
};

/**
 * 将历史消息映射为上游所需的 ChatCompletionMessageParam 数组。
 * @param messages 已确认的聊天消息列表。
 */
const mapMessagesToContext = (
  messages: ChatMessage[],
): ChatConversationMessage[] =>
  messages.reduce<ChatConversationMessage[]>((acc, item) => {
    if (!isSupportedConversationRole(item.role)) {
      return acc;
    }
    const normalized: ChatConversationMessage = {
      role: item.role,
      content: item.content,
    };
    acc.push(normalized);
    return acc;
  }, []);

/**
 * 构造一个默认的助手占位消息，状态为发送中。
 */
const createAssistantPlaceholder = (): ChatMessage => ({
  id: createTempMessageId('assistant'),
  role: 'assistant',
  content: '',
  status: 'sending',
  createdAt: createTimestamp(),
});

/**
 * 聊天 store 的创建器，封装状态初始化与动作实现。
 */
const chatStoreCreator: StateCreator<ChatStore> = (set, get) => ({
  messages: [],
  pendingMessage: null,
  activeAssistantMessage: null,
  currentAbortController: null,
  conversationContext: [],
  inputValue: '',
  hydrateInitialMessages: (initialMessages) => {
    set({
      messages: initialMessages.map((item) => withPersona(item)),
      pendingMessage: null,
      activeAssistantMessage: null,
      conversationContext: mapMessagesToContext(initialMessages),
      inputValue: '',
    });
  },
  prepareNewSubmission: (content) => {
    const pendingMessage = withPersona<ChatPendingMessage>({
      id: createTempMessageId('user'),
      role: 'user',
      content,
      status: 'sending',
      createdAt: createTimestamp(),
    });
    const assistantMessage = withPersona(createAssistantPlaceholder());
    const baseContext = mapMessagesToContext(get().messages);
    const context: ChatConversationMessage[] = [
      ...baseContext,
      { role: 'user', content },
    ];
    set({
      pendingMessage,
      activeAssistantMessage: assistantMessage,
      conversationContext: context,
      inputValue: '',
    });
    return { pendingMessage, assistantMessage, context };
  },
  prepareRetrySubmission: () => {
    const existing = get().pendingMessage;
    if (!existing) {
      throw new Error('当前没有可重试的消息');
    }
    const pendingMessage = withPersona<ChatPendingMessage>({
      ...existing,
      status: 'sending',
      createdAt: existing.createdAt ?? createTimestamp(),
    });
    const assistantMessage = withPersona(createAssistantPlaceholder());
    const baseContext = mapMessagesToContext(get().messages);
    const context: ChatConversationMessage[] = [
      ...baseContext,
      { role: 'user', content: pendingMessage.content },
    ];
    set({
      pendingMessage,
      activeAssistantMessage: assistantMessage,
      conversationContext: context,
    });
    return { pendingMessage, assistantMessage, context };
  },
  appendAssistantDelta: (delta) => {
    set((state) => {
      if (!state.activeAssistantMessage) {
        return state;
      }
      return {
        activeAssistantMessage: {
          ...state.activeAssistantMessage,
          content: `${state.activeAssistantMessage.content}${delta}`,
        },
      };
    });
  },
  finalizeAssistantMessage: (payload) => {
    set((state) => {
      if (
        !state.pendingMessage ||
        !state.activeAssistantMessage ||
        !state.activeAssistantMessage.content.trim()
      ) {
        return state;
      }
      const nextMessages = [...state.messages];
      nextMessages.push({
        id: state.pendingMessage.id ?? createTempMessageId('user'),
        role: state.pendingMessage.role,
        content: state.pendingMessage.content,
        status: 'delivered',
        createdAt: state.pendingMessage.createdAt ?? createTimestamp(),
        displayName: state.pendingMessage.displayName,
        avatar: state.pendingMessage.avatar,
      });
      nextMessages.push({
        ...state.activeAssistantMessage,
        status: 'delivered',
        metadata: {
          finishReason: payload.finishReason,
          usage: payload.usage,
        },
        createdAt: state.activeAssistantMessage.createdAt ?? createTimestamp(),
      });
      return {
        messages: nextMessages,
        pendingMessage: null,
        activeAssistantMessage: null,
        conversationContext: mapMessagesToContext(nextMessages),
        inputValue: '',
      };
    });
  },
  markFailure: () => {
    set((state) => {
      if (!state.pendingMessage) {
        return {
          activeAssistantMessage: null,
          currentAbortController: null,
          conversationContext: mapMessagesToContext(state.messages),
        };
      }
      return {
        pendingMessage: {
          ...state.pendingMessage,
          status: 'failed',
        },
        activeAssistantMessage: null,
        currentAbortController: null,
        conversationContext: mapMessagesToContext(state.messages),
      };
    });
  },
  resetActiveSession: () => {
    set((state) => ({
      pendingMessage: null,
      activeAssistantMessage: null,
      currentAbortController: null,
      conversationContext: mapMessagesToContext(state.messages),
      inputValue: state.inputValue,
    }));
  },
  setAbortController: (controller) => {
    set({ currentAbortController: controller });
  },
  setInputValue: (nextValue) => {
    set({ inputValue: nextValue });
  },
});

/**
 * 导出聊天 store 的 Hook，供组件按需选择字段使用。
 */
export const useChatStore = create<ChatStore>()(devtools(chatStoreCreator, { name: 'chat-store' }));
