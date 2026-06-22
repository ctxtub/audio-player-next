import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';

import type {
  ChatConversationMessage,
  ChatMessage,
  ChatMessageRole,
  ChatStreamDoneEvent,
  MessagePart,
  StoryCardPart,
} from '@/types/chat';
import type { AgentType } from '@/types/agent';
import {
  createAssistantPlaceholder,
  createTempMessageId,
  createTimestamp,
  mapMessagesToContext,
  withPersona,
} from '@/utils/chatUtils';
import type { ChatMessageInput } from '@/lib/trpc/schemas/chatConversation';
import { fetchMyConversation, saveMyConversation } from '@/lib/client/chatConversation';

/**
 * 聊天 Store 的 Action 定义，统一管理所有对单条目消息状态的变更操作。
 */
export type ChatStoreAction =
  // 用户触发
  | { type: 'user.submit'; content: string } // 提交新消息
  | { type: 'user.retry' }                   // 重试上一条失败消息
  // 流式更新
  | { type: 'stream.delta'; content: string }          // 追加内容
  | { type: 'stream.intent'; intent: 'Story' | 'Chat' | 'Guidance' } // 更新意图
  | { type: 'stream.finish'; payload: ChatStreamDoneEvent } // 普通对话完成
  | { type: 'stream.story_finish'; storyText: string; audioUrl: string } // 故事生成完成
  | { type: 'stream.fail'; error?: string }            // 失败
  | {
    type: 'summary.update';
    summaryText: string;
    insertAfterMessageId?: string;
    oldSummaryId?: string
  }; // 总结更新

/**
 * 聊天 Store 的计算属性与选择器接口。
 * 将所有数据读取逻辑收敛于此，避免在组件中直接操作复杂的过滤逻辑。
 */
interface ChatStoreSelectors {
  /** 检查 ID 是否为最新一条消息 */
  isLatestMessage: (id: string) => boolean;

  /** 获取下一段可播放的故事片段 (Derived from Message) */
  nextStorySegment: (currentId: string) => { audioUrl: string; storyText: string; messageId: string } | null;

  /** 获取用于 API 请求的上下文消息列表 (Conversation Messages) */
  conversationMessages: () => ChatConversationMessage[];

  /** 最新的一条消息 */
  latestMessage: () => ChatMessage | undefined;

  /** 最新的一条助手消息 */
  latestAssistantMessage: () => ChatMessage | undefined;

  /** 最新的一条失败消息 (用于重试) */
  latestFailedMessage: () => ChatMessage | undefined;

  /** 是否存在历史故事消息 (用于自动播放判断) */
  hasStoryMessages: (excludeId?: string) => boolean;
}

/**
 * 聊天 store 的基础状态，记录历史消息与当前请求。
 */
type ChatStoreBaseState = {
  /** 
   * 聊天消息列表，包含所有状态（sending, failed, delivered）。
   * 作为唯一的真实数据源，驱动 UI 展示与逻辑判断。
   */
  messages: ChatMessage[];
  /** 输入框中的实时内容，供建议快捷填充。 */
  inputValue: string;
  /** 是否有未读的 AI 响应（用于 TabBar 小红点）。 */
  hasUnviewedResponse: boolean;
  /** 是否处于登录态（开启服务端持久化）。 */
  syncEnabled: boolean;
  /** 跨页自动发送的待发提示词（来自 /player 历史记录选择，瞬态、不持久化）。 */
  pendingAutoSend: string | null;
};

/**
 * 聊天 store 暴露的动作集合。
 */
type ChatStoreActions = {

  /** 触发历史消息总结逻辑 (Frontend Trigger)。 */
  checkAndSummarize: () => Promise<void>;

  /** 主动取消时清理占位消息与上下文。 */
  resetActiveSession: () => void;
  /** 清空所有历史消息（同时清空服务端会话） */
  resetChat: () => void;
  /** 登录后：拉取服务端会话并恢复，开启持久化。 */
  initForUser: () => Promise<void>;
  /** 登出：仅清本地并关闭持久化，不动服务端。 */
  reset: () => void;
  /** 更新输入框的实时内容。 */
  setInputValue: (nextValue: string) => void;
  /** 设置/清空跨页自动发送的待发提示词。 */
  setPendingAutoSend: (prompt: string | null) => void;
  /**
   * 标记当前会话为已读，清除未读 AI 响应红点。
   */
  markResponseAsViewed: () => void;

  /** 
   * 统一的消息操作入口。
   * @param action 具体的操作指令
   */
  dispatch: (action: ChatStoreAction) => void;

  /**
   * 计算与查询方法集。
   */
  selectors: ChatStoreSelectors;
};

/**
 * 聊天 store 的完整类型定义。
 */
export type ChatStore = ChatStoreBaseState & ChatStoreActions;

/**
 * 聊天 Store 创建器。
 * 封装了状态初始化、Action 分发 (dispatch) 以及 Selectors 实现。
 */
/** 会话快照保存的防抖间隔（毫秒）。 */
const SAVE_DEBOUNCE_MS = 1000;

/**
 * 合并会话：服务端历史在前，本地窗口内新增按 id 去重续后。
 * 用于 initForUser 终态——既恢复账号历史，又不冲掉 await 窗口内刚发的消息（项 3）。
 * @param server 服务端恢复的消息（基准顺序）。
 * @param local await 窗口内本地新增、需保留的消息。
 * @returns 合并后的有序消息列表。
 */
const mergeConversation = (
  server: ChatMessage[],
  local: ChatMessage[],
): ChatMessage[] => {
  const serverIds = new Set(server.map((message) => message.id));
  const appended = local.filter((message) => !serverIds.has(message.id));
  return [...server, ...appended];
};

const chatStoreCreator: StateCreator<ChatStore> = (set, get) => {
  /** 防抖保存定时器。 */
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** initForUser 去重：进行中的拉取 Promise。 */
  let userInitPromise: Promise<void> | null = null;
  /** 账号代次：reset 自增，作废在途 initForUser 的回写。 */
  let accountEpoch = 0;

  /**
   * 取完成态消息构造保存快照（含 summary 锚点，便于恢复后压缩上下文；storyCard 的音频置空不存）。
   * @param messages 当前消息列表。
   */
  const toSnapshot = (messages: ChatMessage[]): ChatMessageInput[] =>
    messages
      .filter(
        (message) => message.status === undefined || message.status === 'delivered',
      )
      .map((message) => {
        const parts = message.parts?.map((part) =>
          part.type === 'storyCard' ? { ...part, audioUrl: '' } : part,
        );
        return {
          messageId: message.id,
          role: message.role,
          content: message.content,
          parts,
          agentType: message.metadata?.agentType,
          createdAt: message.createdAt,
        };
      });

  /**
   * 防抖保存当前会话快照：登录态且无在途消息时整条替换服务端。
   */
  const scheduleSave = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const state = get();
      if (!state.syncEnabled) {
        return;
      }
      // 有在途消息则跳过，待其完成后再次触发
      if (state.messages.some((message) => message.status === 'sending')) {
        return;
      }
      saveMyConversation(toSnapshot(state.messages)).catch((error) => {
        console.warn('[chatStore] saveMyConversation failed', error);
      });
    }, SAVE_DEBOUNCE_MS);
  };

  return {
  messages: [],
  inputValue: '',
  hasUnviewedResponse: false,
  syncEnabled: false,
  pendingAutoSend: null,
  dispatch: (action: ChatStoreAction) => {
    set((state) => {
      const messages = [...state.messages];

      switch (action.type) {
        case 'user.submit': {
          const userMsg = withPersona<ChatMessage>({
            id: createTempMessageId('user'),
            role: 'user',
            content: action.content,
            status: 'sending',
            createdAt: createTimestamp(),
          });
          const assistantMsg = withPersona(createAssistantPlaceholder());
          return {
            messages: [...messages, userMsg, assistantMsg],
            inputValue: '',
          };
        }
        case 'user.retry': {
          // 找到最后一条失败的 User 消息
          const lastIndex = messages.findLastIndex(m => m.role === 'user' && m.status === 'failed');
          if (lastIndex === -1) {
            console.warn('No failed message to retry');
            return state;
          }
          // 更新该消息为 sending，并更新时间戳？通常重试就是保持内容不变
          messages[lastIndex] = {
            ...messages[lastIndex],
            status: 'sending',
            createdAt: createTimestamp(), // 更新时间戳以便重新排序？或者保持原样
          };

          // 检查是否有后续的助手消息（可能是 failed 或者不存在）
          // 简单的策略：移除后续的所有消息（通常是失败的助手占位），并重新添加一个新的助手占位
          // 但如果要保留历史（例如中间夹杂了其他），这里我们假设重试总是针对对话流的末尾
          // 为了安全，我们只处理末尾的情况。如果 lastIndex 不是倒数第一/第二，可能需要更复杂的逻辑。
          // 简化：追加一个新的助手占位
          const assistantMsg = withPersona(createAssistantPlaceholder());

          // 清理 lastIndex 之后的所有消息（假设它们是之前的失败尝试产生的垃圾）
          const newMessages = messages.slice(0, lastIndex + 1);
          newMessages.push(assistantMsg);

          return {
            messages: newMessages,
          };
        }
        case 'stream.delta': {
          // 找到最后一条助手消息（应该处于 sending 状态）
          const lastAssistantIndex = messages.findLastIndex(m => m.role === 'assistant' && m.status === 'sending');
          if (lastAssistantIndex === -1) return state;

          const msg = messages[lastAssistantIndex];
          const newContent = msg.content + action.content;

          let newParts = msg.parts;
          if (newParts && newParts.length > 0) {
            const firstPart = newParts[0];
            if (firstPart.type === 'storyCard') {
              newParts = [{ ...firstPart, storyText: newContent }, ...newParts.slice(1)];
            } else if (firstPart.type === 'guidance') {
              newParts = [{ ...firstPart, content: newContent }, ...newParts.slice(1)];
            }
          }

          messages[lastAssistantIndex] = {
            ...msg,
            content: newContent,
            parts: newParts,
          };
          return { messages };
        }
        case 'stream.intent': {
          const lastAssistantIndex = messages.findLastIndex(m => m.role === 'assistant' && m.status === 'sending');
          if (lastAssistantIndex === -1) return state;

          const msg = messages[lastAssistantIndex];
          const currentContent = msg.content;
          let newParts = msg.parts;

          let agentType: AgentType | undefined;
          switch (action.intent) {
            case 'Story':
              agentType = 'story_agent';
              // 转换消息片段为 StoryCardPart
              newParts = [{
                type: 'storyCard',
                storyText: currentContent,
                audioUrl: '', // 初始为空
              }];
              break;
            case 'Chat':
              agentType = 'chat_agent';
              break;
            case 'Guidance':
              agentType = 'guidance_agent';
              // 转换消息片段为 GuidancePart
              newParts = [{
                type: 'guidance',
                content: currentContent,
              } as any];
              break;
          }

          if (agentType) {
            messages[lastAssistantIndex] = {
              ...msg,
              parts: newParts,
              metadata: {
                ...msg.metadata,
                agentType,
              },
            };
          }
          return { messages };
        }
        case 'stream.finish': {
          const lastAssistantIndex = messages.findLastIndex(m => m.role === 'assistant' && m.status === 'sending');
          // 逻辑说明：stream.finish 仅标记流结束。
          // 若之前处于 sending 状态，则更新为 delivered，并记录结束原因与 Token 用量。

          if (lastAssistantIndex !== -1) {
            messages[lastAssistantIndex] = {
              ...messages[lastAssistantIndex],
              status: 'delivered',
              metadata: {
                ...messages[lastAssistantIndex].metadata,
                finishReason: action.payload.finishReason,
                usage: action.payload.usage,
              },
            };
          }

          // 确保最近的 User 消息也是 delivered
          const lastUserIndex = messages.findLastIndex(m => m.role === 'user' && m.status === 'sending');
          if (lastUserIndex !== -1) {
            messages[lastUserIndex] = { ...messages[lastUserIndex], status: 'delivered' };
          }

          return {
            messages,
            hasUnviewedResponse: true,
          };
        }
        case 'stream.story_finish': {
          const lastAssistantIndex = messages.findLastIndex(m => m.role === 'assistant' && m.status === 'sending');
          if (lastAssistantIndex !== -1) {
            const storyPart: StoryCardPart = {
              type: 'storyCard',
              storyText: action.storyText,
              audioUrl: action.audioUrl,
            };
            messages[lastAssistantIndex] = {
              ...messages[lastAssistantIndex],
              content: action.storyText,
              parts: [storyPart],
              status: 'delivered',
            };
          }

          // 确保最近的 User 消息也是 delivered
          const lastUserIndex = messages.findLastIndex(m => m.role === 'user' && m.status === 'sending');
          if (lastUserIndex !== -1) {
            messages[lastUserIndex] = { ...messages[lastUserIndex], status: 'delivered' };
          }

          return {
            messages,
            hasUnviewedResponse: true,
          };
        }
        case 'stream.fail': {
          // 标记最后正在发送的消息为失败
          // 通常是助手消息和用户消息
          const lastAssistantIndex = messages.findLastIndex(m => m.role === 'assistant' && m.status === 'sending');
          if (lastAssistantIndex !== -1) {
            messages[lastAssistantIndex] = { ...messages[lastAssistantIndex], status: 'failed' }; // 或者直接移除助手占位？通常保留显示失败
            // 逻辑说明：将最后一条正在发送的 Assistant 消息移除（避免展示空气泡），
            // 并将最后一条 User 消息标记为 failed，以便用户可以点击重试。
            messages.splice(lastAssistantIndex, 1);
          }

          const lastUserIndex = messages.findLastIndex(m => m.role === 'user' && m.status === 'sending');
          if (lastUserIndex !== -1) {
            messages[lastUserIndex] = { ...messages[lastUserIndex], status: 'failed' };
          }

          return { messages };
        }
        case 'summary.update': {
          // 1. 仅移除旧的总结消息
          const messagesWithoutOldSummary = messages.filter(m => m.id !== action.oldSummaryId);

          // 2. 创建新的总结消息
          const summaryMsg: ChatMessage = {
            id: createTempMessageId('system'),
            role: 'assistant',
            content: action.summaryText,
            // View 层根据 agentType 决定 displayName
            // displayName: '摘要Agent',
            parts: [{ type: 'summary', content: action.summaryText }],
            createdAt: createTimestamp(),
            status: 'delivered',
            metadata: { agentType: 'summary_agent' }
          };

          // 3. 找到插入索引
          // 我们希望将新总结插入到“被总结的最后一条消息”之后
          const insertIndex = messagesWithoutOldSummary.findIndex(m => m.id === action.insertAfterMessageId);

          const newMessages = [...messagesWithoutOldSummary];
          if (insertIndex !== -1) {
            newMessages.splice(insertIndex + 1, 0, summaryMsg);
          } else {
            // 兜底：如果未找到目标消息（例如初始空上下文被总结？），则插在头部
            newMessages.unshift(summaryMsg);
          }

          return {
            messages: newMessages
          };
        }
        default:
          return state;
      }
    });
    // 任一消息变更后调度防抖保存（内部按登录态/在途状态决定是否真正保存）
    scheduleSave();
  },

  checkAndSummarize: async () => {
    const { messages, dispatch } = get();
    // 定义阈值：
    // TRIGGER_THRESHOLD: 当普通消息积累超过 4 条 (2轮对话) 时触发检查
    // RETAIN_THRESHOLD: 触发总结后，仅保留最近 2 条 (1轮对话) 普通消息，其余归档
    // 这种"高水位-低水位"机制（Hysteresis）可以实现每 2 轮对话触发一次批量总结，避免过于频繁
    const TRIGGER_THRESHOLD = 4;
    const RETAIN_THRESHOLD = 2;

    // 2. 找到所有非 Summary、非 System 的普通消息（User/Assistant）
    // 以及现有的 Summary 消息
    const summaryMsgIndex = messages.findIndex(m => m.metadata?.agentType === 'summary_agent');
    const existingSummaryMsg = summaryMsgIndex !== -1 ? messages[summaryMsgIndex] : null;

    // 确定普通消息的起始点：如果存在 Summary，则从 Summary 之后开始找；否则从头开始
    const normalMessagesStartIndex = summaryMsgIndex !== -1 ? summaryMsgIndex + 1 : 0;
    const normalMessages = messages.slice(normalMessagesStartIndex).filter(m =>
      ['user', 'assistant'].includes(m.role) && m.metadata?.agentType !== 'summary_agent'
    );

    // 3. 检查数量是否超过触发阈值
    if (normalMessages.length <= TRIGGER_THRESHOLD) {
      return;
    }

    // 4. 准备需要总结的消息：现存 Summary (作为上下文) + 待归档的普通消息
    // 待归档消息 = 所有普通消息 - 最近保留的 RETAIN_THRESHOLD 条
    const messagesToArchive = normalMessages.slice(0, -RETAIN_THRESHOLD);

    if (messagesToArchive.length === 0) return;

    // 记录最后一条被总结的消息 ID，新总结将插在它之后
    const lastArchivedMsgId = messagesToArchive[messagesToArchive.length - 1].id;

    // 构造请求 payload
    // 注意：这里需要转换为 AgentMessage 格式 (简单的 role/content 对象)
    // 且只取这部分作为 summarize 的输入
    const contextForSummary = [
      ...(existingSummaryMsg ? [{ role: existingSummaryMsg.role, content: existingSummaryMsg.content }] : []),
      ...messagesToArchive.map(m => ({ role: m.role, content: m.content }))
    ] as any[]; // cast to AgentMessage[]

    try {
      const { summarizeContext } = await import('@/app/services/agentFlow');
      const summaryText = await summarizeContext(contextForSummary);

      // 5. 更新 Store
      // 这里的逻辑已调整：不删除历史消息，只替换 Summary 节点的位置
      dispatch({
        type: 'summary.update',
        summaryText,
        insertAfterMessageId: lastArchivedMsgId,
        oldSummaryId: existingSummaryMsg?.id
      } as any);

    } catch (error) {
      console.error('[SummaryAgent] Failed to summarize:', error);
    }
  },

  resetActiveSession: () => {
    // 重置会话：移除所有处于 sending 状态的临时消息，
    // 通常在用户主动取消生成，或页面卸载时调用。
    set((state) => ({
      messages: state.messages.filter(m => m.status !== 'sending'),
    }));
    scheduleSave();
  },
  resetChat: () => {
    set({
      messages: [],
    });
    // 清空后保存空快照即清空服务端会话
    scheduleSave();
  },
  initForUser: () => {
    if (get().syncEnabled) {
      return Promise.resolve();
    }
    if (userInitPromise) {
      return userInitPromise;
    }
    const epoch = accountEpoch; // 捕获进入代次
    const baselineIds = new Set(get().messages.map((message) => message.id)); // 进入时已有（访客/旧态）
    userInitPromise = (async () => {
      const dtos = await fetchMyConversation();
      if (epoch !== accountEpoch) {
        return; // 账号已切（登出/401）→ 放弃回写（项 4）
      }
      const serverMessages: ChatMessage[] = dtos.map((dto) => ({
        id: dto.messageId,
        role: dto.role as ChatMessageRole,
        content: dto.content,
        parts: dto.parts as MessagePart[] | undefined,
        status: 'delivered',
        createdAt: dto.createdAt,
        metadata: dto.agentType ? { agentType: dto.agentType as AgentType } : undefined,
      }));
      // await 窗口内本地新增（非 baseline）的消息，需在恢复后保留（项 3）
      const appendedLocally = get().messages.filter(
        (message) => !baselineIds.has(message.id),
      );
      // 直接 set，不触发 scheduleSave，避免把恢复结果回写
      set({ messages: mergeConversation(serverMessages, appendedLocally), syncEnabled: true });
    })()
      .catch((error) => {
        console.warn('[chatStore] initForUser failed', error);
      })
      .finally(() => {
        if (epoch === accountEpoch) {
          userInitPromise = null;
        }
      });
    return userInitPromise;
  },
  reset: () => {
    accountEpoch++; // 作废在途 initForUser 的回写
    userInitPromise = null; // 让重新登录能起新请求
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    set({
      messages: [],
      inputValue: '',
      hasUnviewedResponse: false,
      syncEnabled: false,
    });
  },
  setInputValue: (nextValue) => {
    set({ inputValue: nextValue });
  },
  setPendingAutoSend: (prompt) => {
    set({ pendingAutoSend: prompt });
  },
  markResponseAsViewed: () => {
    set({ hasUnviewedResponse: false });
  },
  selectors: {
    isLatestMessage: (id) => {
      const messages = get().messages;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === 'assistant' && msg.parts?.some(p => p.type === 'storyCard')) {
          return msg.id === id;
        }
      }
      return false;
    },
    nextStorySegment: (currentMessageId) => {
      const messages = get().messages;
      const currentIndex = messages.findIndex((m) => m.id === currentMessageId);

      if (currentIndex === -1 || currentIndex === messages.length - 1) {
        return null;
      }

      // 从当前消息的下一条开始查找助手消息（包含故事卡片）
      for (let i = currentIndex + 1; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'assistant' && msg.parts) {
          const storyPart = msg.parts.find((p) => p.type === 'storyCard') as StoryCardPart | undefined;
          if (storyPart && storyPart.audioUrl && storyPart.storyText) {
            return {
              audioUrl: storyPart.audioUrl,
              storyText: storyPart.storyText,
              messageId: msg.id,
            };
          }
        }
      }

      return null;
    },
    conversationMessages: () => {
      const messages = get().messages;
      // 过滤逻辑：
      // 1. 找到最后一条 Summary 消息。
      const lastSummaryIndex = messages.findLastIndex(m => m.metadata?.agentType === 'summary_agent');

      // 2. 如果存在，则截取 [Summary ... 结尾] 的片段。
      //    如果不存在，则使用全量消息。
      const effectiveMessages = lastSummaryIndex !== -1
        ? messages.slice(lastSummaryIndex)
        : messages;

      return mapMessagesToContext(effectiveMessages);
    },
    latestMessage: () => {
      const messages = get().messages;
      return messages[messages.length - 1];
    },
    latestAssistantMessage: () => {
      return get().messages.findLast((m) => m.role === 'assistant');
    },
    latestFailedMessage: () => {
      return get().messages.findLast((m) => m.status === 'failed');
    },
    hasStoryMessages: (excludeMessageId) => {
      const messages = get().messages;
      const targetIndex = excludeMessageId
        ? messages.findIndex((m) => m.id === excludeMessageId)
        : messages.length;

      if (targetIndex === -1) {
        // 如果没找到排除的消息，说明它可能还没加入列表，或者 ID 传错了。
        // 无妨，搜索整个列表。
        return messages.some((msg) =>
          msg.role === 'assistant' && msg.parts?.some((p) => p.type === 'storyCard')
        );
      }

      // Search in messages before targetIndex
      return messages.slice(0, targetIndex).some((msg) =>
        msg.role === 'assistant' && msg.parts?.some((p) => p.type === 'storyCard')
      );
    },
  },
  };
};

/**
 * 导出聊天 store 的 Hook，供组件按需选择字段使用。
 */
export const useChatStore = create<ChatStore>()(devtools(chatStoreCreator, { name: 'chat-store' }));
