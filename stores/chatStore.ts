import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';

import type {
  ChatConversationMessage,
  ChatMessage,
  ChatMessageRole,
  ChatStreamDoneEvent,
  MessagePart,
  StoryArtifactPart,
  // Legacy 只读：选择器/快照仍需识别历史 storyCard（M4-02 新写链已不再创建，正式 cutover 放 M4-08）。
  StoryCardPart,
} from '@/types/chat';
import {
  createDraftArtifact,
  appendDraftChunk,
  completeArtifact,
  interruptArtifact,
} from '@/lib/client/chatArtifactState';
import {
  isDraftArtifact,
  isCompleteArtifact,
  isPromotingArtifact,
  isPromotionFailedArtifact,
} from '@/types/chatArtifact';
import type { CompleteChatArtifact, PromotionFailedChatArtifact } from '@/types/chatArtifact';
import {
  beginPromotion,
  executePromotionCreate,
  finishPromotionAsFailed,
  finishPromotionAsReady,
  type PromotionSourceArtifact,
} from '@/lib/client/chatPromotionOrchestration';
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
export type ChatMessageOrigin = 'user' | 'preload';

/**
 * 预载来源标记常量，写入消息 metadata.origin。
 */
export const CHAT_PRELOAD_ORIGIN: ChatMessageOrigin = 'preload';

/**
 * 判断是否为预载续写产生的用户指令泡（渲染与落库时需隐藏）。
 * 仅以 metadata.origin === 'preload' 为准；无标记（含重载恢复丢失 origin）一律视为人工消息，
 * 避免人工同文「请继续故事」被误判隐藏并在下次保存时从服务端删除（H-03-a）。
 * 历史预载泡（修前落库的无标记指令泡）重载后一次性可见，为接受的 cosmetic 代价。
 * @param message 待判断的聊天消息。
 * @returns 预载指令泡返回 true，其余返回 false。
 */
export const isPreloadUserMessage = (message: ChatMessage): boolean => {
  if (message.role !== 'user') {
    return false;
  }
  const origin = (message.metadata as { origin?: string } | undefined)?.origin;
  return origin === CHAT_PRELOAD_ORIGIN;
};

export type ChatStoreAction =
  // 用户触发
  // M4-03 快照冻结：submit 可携带生成开始时的 prompt/voice 快照（chatFlow 显式传入）；
  // 缺省时 prompt 回退为本次 action.content，voice 回退为 undefined（由 chatFlow 负责传入真实快照）。
  | { type: 'user.submit'; content: string; origin?: ChatMessageOrigin; promptSnapshot?: string; voiceSnapshot?: string } // 提交新消息
  // M4-03 快照冻结：retry 必须重建新 assistant/sourceMessageId，且新 attempt 携带本次实际使用的 prompt/voice 快照；
  // 缺省时 prompt 回退为配对失败 user 内容，voice 回退为 undefined（由 chatFlow 负责传入真实快照）。
  | { type: 'user.retry'; promptSnapshot?: string; voiceSnapshot?: string }                   // 重试上一条失败消息
  // 流式更新
  | { type: 'stream.delta'; content: string; messageId?: string }          // 追加内容
  | { type: 'stream.intent'; intent: 'Story' | 'Chat' | 'Guidance'; messageId?: string } // 更新意图
  | { type: 'stream.story_complete'; messageId: string; storyText?: string; title?: string } // 故事正文终端完成（M4-02）
  | { type: 'stream.finish'; payload?: ChatStreamDoneEvent; messageId?: string } // 普通对话或流传输完成
  | { type: 'stream.fail'; error?: string; messageId?: string }            // 失败
  | { type: 'stream.abort'; messageId?: string; reason?: string }          // 中断
  // M4-04 promotion 编排回写（仅 orchestration 内部派发；归属校验失败一律 no-op）
  | { type: 'promotion.resolved'; messageId: string; promotionToken: number; promotionEpoch: number; storyWorkId: number } // promotion 成功回写 ready
  | { type: 'promotion.rejected'; messageId: string; promotionToken: number; promotionEpoch: number; error?: string } // promotion 失败回写 promotion_failed
  // M4-04 promotion 幂等重试（仅 promotion_failed 可重试；只重发入库写，不走 generation transport）
  | { type: 'promotion.retry'; messageId: string }                         // 重试单条 Artifact 的 promotion
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
  /** 最近一次快照保存的失败原因（null 表示无失败；失败不静默丢，由调用方/退出 flush 断言）。 */
  saveError: string | null;
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
  /**
   * 退出前同步落盘：取消防抖定时器并立即保存当前快照（即使有 sending 在途，
   * 已完结前缀仍落盘；在途消息本就不进快照）。
   * @returns 保存是否执行且成功（未登录返回 false；失败置 saveError 并返回 false）。
   */
  flushPendingSave: () => Promise<boolean>;
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

/**
 * M4-02 身份定位辅助：按 assistant message id 精确定位，不再以「最后一条」归属异步回调。
 * messageId 明确时严格按 id 查找；缺失时（legacy 兼容）才回退到最后一条 sending 助手消息。
 * @param messages 当前消息列表。
 * @param messageId 目标助手消息 id（attempt 身份）。
 * @returns 目标下标，未找到返回 -1。
 */
const findAssistantIndexById = (
  messages: ChatMessage[],
  messageId: string | undefined,
): number => {
  if (messageId) {
    return messages.findIndex((m) => m.id === messageId && m.role === 'assistant');
  }
  return messages.findLastIndex((m) => m.role === 'assistant' && m.status === 'sending');
};

/**
 * M4-02 fixup 身份定位辅助：按 assistant attempt 向前找其配对 user。
 * 从 assistantIndex 向前找最近一条 role==='user' 的 message，即该 assistant attempt 的 paired user。
 * 三个 terminal handler（finish/fail/abort）共用此唯一实现，只修改 paired user，
 * 旧 Attempt 的 terminal 事件不得污染其它 Attempt（E2E-08-02 冻结语义）。
 * @param messages 当前消息列表。
 * @param assistantIndex 目标助手消息下标（attempt 身份）。
 * @returns 配对 user 下标，未找到返回 -1。
 */
const findUserIndexForAssistant = (
  messages: ChatMessage[],
  assistantIndex: number,
): number => {
  if (assistantIndex < 0 || assistantIndex >= messages.length) {
    return -1;
  }
  for (let i = assistantIndex - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return i;
    }
  }
  return -1;
};

/**
 * 取消息内 Modern Artifact 片段（有且仅有一个）。
 */
const getStoryArtifactPart = (msg: ChatMessage): StoryArtifactPart | undefined =>
  msg.parts?.find((p): p is StoryArtifactPart => p.type === 'storyArtifact');

/**
 * 将 Artifact 写回消息（同步 content 与 parts，保持单源真相）。
 */
const withArtifact = (msg: ChatMessage, artifact: StoryArtifactPart['artifact']): ChatMessage => ({
  ...msg,
  content: artifact.storyText,
  parts: [
    ...(msg.parts?.filter((p) => p.type !== 'storyArtifact') ?? []),
    { type: 'storyArtifact', artifact } as StoryArtifactPart,
  ],
});

const chatStoreCreator: StateCreator<ChatStore> = (set, get) => {
  /** 防抖保存定时器。 */
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** initForUser 去重：进行中的拉取 Promise。 */
  let userInitPromise: Promise<void> | null = null;
  /** 账号代次：reset 自增，作废在途 initForUser 的回写。 */
  let accountEpoch = 0;
  /** H-15 基线：上次读取/落盘成功的 messageId 序列（内存，不持久化）。 */
  let baselineMessageIds: string[] | undefined = undefined;
  /**
   * M4-04 promotion 编排瞬态守卫（客户端 async race guard，不进持久领域模型）：
   * - promotionSeq：全局单调 promotionToken 计数器，每次 kick 自增；
   * - promotionEpoch：resetChat/reset/resetActiveSession 自增，旧 promotion resolve/reject 凭此 no-op；
   * - inflightPromotions：messageId → 在途 promotion 归属（同一 messageId 最多一个 in-flight create）；
   * - pendingPromotionKicks：set() 内登记、dispatch 尾部统一 drain，避免 updater 内直接做异步副作用。
   */
  let promotionSeq = 0;
  let promotionEpoch = 0;
  const inflightPromotions = new Map<string, { token: number; epoch: number }>();
  const pendingPromotionKicks: {
    messageId: string;
    token: number;
    epoch: number;
    source: PromotionSourceArtifact;
  }[] = [];

  /**
   * M4-04：登记一次 promotion kick（调用方已把 Artifact 置为 promoting）。
   * 同一 messageId 已有在途 promotion 时拒绝登记（调用方不得重复 kick）。
   */
  const enqueuePromotionKick = (
    messageId: string,
    source: PromotionSourceArtifact,
  ): { token: number; epoch: number } | null => {
    if (inflightPromotions.has(messageId)) {
      return null;
    }
    promotionSeq += 1;
    const kick = { token: promotionSeq, epoch: promotionEpoch, source };
    inflightPromotions.set(messageId, { token: kick.token, epoch: kick.epoch });
    pendingPromotionKicks.push({ messageId, ...kick });
    return { token: kick.token, epoch: kick.epoch };
  };

  /**
   * M4-04：drain 本次 dispatch 登记的 promotion kicks（dispatch 尾部调用，set() 之后）。
   * 异步 create 结算后一律经 promotion.resolved/rejected 回写，由归属校验决定生效或 no-op。
   */
  const drainPromotionKicks = () => {
    if (pendingPromotionKicks.length === 0) {
      return;
    }
    const kicks = pendingPromotionKicks.splice(0, pendingPromotionKicks.length);
    for (const kick of kicks) {
      void executePromotionCreate(kick.source).then(
        (dto) => {
          get().dispatch({
            type: 'promotion.resolved',
            messageId: kick.messageId,
            promotionToken: kick.token,
            promotionEpoch: kick.epoch,
            storyWorkId: dto.id,
          });
        },
        (error) => {
          get().dispatch({
            type: 'promotion.rejected',
            messageId: kick.messageId,
            promotionToken: kick.token,
            promotionEpoch: kick.epoch,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    }
  };

  /**
   * M4-04：promotion 结果归属校验（stale 防线核心）。
   * 只有「epoch 未变 ＋ slot 仍属该 token ＋ 消息仍存在 ＋ 当前 Artifact 仍是该次
   * promotion 对应的 promoting generation（status==='promoting' 且 sourceMessageId 一致）」
   * 四项全过才允许写回；任一失败一律 no-op（拥有 slot 时顺手释放，避免泄漏）。
   */
  const claimPromotionSlot = (
    messages: ChatMessage[],
    messageId: string,
    promotionToken: number,
    epoch: number,
  ): { msg: ChatMessage; index: number } | null => {
    if (epoch !== promotionEpoch) {
      return null;
    }
    const inflight = inflightPromotions.get(messageId);
    if (!inflight || inflight.token !== promotionToken || inflight.epoch !== epoch) {
      return null;
    }
    const index = messages.findIndex((m) => m.id === messageId && m.role === 'assistant');
    if (index === -1) {
      inflightPromotions.delete(messageId);
      return null;
    }
    const msg = messages[index];
    const existing = getStoryArtifactPart(msg);
    if (
      !existing ||
      !isPromotingArtifact(existing.artifact) ||
      existing.artifact.sourceMessageId !== messageId
    ) {
      inflightPromotions.delete(messageId);
      return null;
    }
    inflightPromotions.delete(messageId);
    return { msg, index };
  };

  /**
   * M4-04：作废全部在途 promotion（resetChat/reset/resetActiveSession 调用）。
   * 旧 resolve/reject 凭 epoch 失配 no-op；在途 slot 同步清空防泄漏。
   */
  const invalidateInflightPromotions = () => {
    promotionEpoch += 1;
    inflightPromotions.clear();
  };

  /**
   * M4-04：将已完成的 Artifact 置为 promoting 并登记 async kick（story_complete 两分支共用）。
   * beginPromotion 抛错时停留在 complete（不抛、不 kick）；kick 登记走在途去重，
   * 重复登记直接忽略（Artifact 已是 promoting，后续 duplicate 事件同样忽略）。
   */
  const writePromotingAndKick = (
    messages: ChatMessage[],
    targetIndex: number,
    completed: CompleteChatArtifact,
    messageId: string,
  ): void => {
    let promoting;
    try {
      promoting = beginPromotion(completed);
    } catch {
      messages[targetIndex] = withArtifact(messages[targetIndex], completed);
      return;
    }
    messages[targetIndex] = withArtifact(messages[targetIndex], promoting);
    enqueuePromotionKick(messageId, completed);
  };

  /**
   * 判断是否为基线冲突错误（服务端 CONFLICT 拒写）。
   * @param error 待判断的保存错误。
   */
  const isConflictError = (error: unknown): boolean => {
    if (typeof error === 'object' && error !== null) {
      if ((error as { code?: unknown }).code === 'CONFLICT') {
        return true;
      }
      if ((error as { data?: { code?: unknown } }).data?.code === 'CONFLICT') {
        return true;
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('CONFLICT') || message.includes('其它标签页');
  };

  /**
   * CONFLICT 后经 initForUser 口径刷新服务端快照（不静默丢，已置 saveError+toast）。
   */
  const refreshAfterConflict = async (): Promise<void> => {
    // 中文注释：解 syncEnabled 以允许 initForUser 重拉；窗口内新增由其合并保留。
    set({ syncEnabled: false });
    userInitPromise = null;
    await get().initForUser();
  };

  /**
   * 显示基线冲突提示（懒加载 GlassToast，避免 Node 单测启动时解析 .tsx）。
   * 测试可经 globalThis.__H15_TOAST__ 注入捕获桩；浏览器走真实 GlassToast。
   */
  const showConflictToast = (): void => {
    const content = '会话已被其它标签页更新，已刷新';
    try {
      const stubbed = (globalThis as { __H15_TOAST__?: { show: (config: unknown) => void } }).__H15_TOAST__;
      if (stubbed) {
        stubbed.show({ icon: 'fail', content });
        return;
      }
    } catch {
      // 中文注释：取桩失败则继续走真实 Toast。
    }
    // 中文注释：浏览器懒加载真实 GlassToast；Node 无 DOM/解析失败时忽略，仅保留 saveError。
    void import('@/components/ui/GlassToast')
      .then((mod) => {
        (mod.default as { show: (config: { icon: string; content: string }) => void }).show({
          icon: 'fail',
          content,
        });
      })
      .catch(() => {});
  };

  /** H-16 退出 flush 在途去重锁：beforeunload+pagehide 双触发共享同一次保存。 */
  let flushInFlight: Promise<boolean> | null = null;

  /**
   * 取完成态消息构造保存快照（含 summary 锚点，便于恢复后压缩上下文；storyCard 的音频置空不存）。
   * @param messages 当前消息列表。
   */
  const toSnapshot = (messages: ChatMessage[]): ChatMessageInput[] =>
    messages
      .filter((message) => !isPreloadUserMessage(message))
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
      // 中文注释：H-15 基线透传——保存时带上读取/落盘基线，成功后更新基线。
      const snapshot = toSnapshot(state.messages);
      const baselineAtSend = baselineMessageIds;
      saveMyConversation(snapshot, baselineAtSend).then(() => {
        baselineMessageIds = snapshot.map((message) => message.messageId);
        set({ saveError: null });
      }).catch((error) => {
        // 中文注释：H-15 CONFLICT 不静默丢——置标记位＋toast＋initForUser 刷新。
        if (isConflictError(error)) {
          const reason = error instanceof Error ? error.message : String(error);
          set({ saveError: reason });
          showConflictToast();
          console.warn('[chatStore] saveMyConversation conflict', error);
          void refreshAfterConflict();
          return;
        }
        const reason = error instanceof Error ? error.message : String(error);
        set({ saveError: reason });
        console.warn('[chatStore] saveMyConversation failed', error);
      });
    }, SAVE_DEBOUNCE_MS);
  };

  /**
   * 退出前同步落盘：取消防抖并立即保存已完结快照，失败置标记位。
   * H-16：fetch keepalive 送达保障（仅浏览器分支包装底层 fetch，基线透传与 saveError 主逻辑不变）
   * ＋ in-flight 去重锁（双触发只存一次，结算后释放）。
   * @returns 保存是否执行且成功。
   */
  const flushPendingSave = async (): Promise<boolean> => {
    if (flushInFlight) {
      return flushInFlight;
    }
    const runFlush = (async (): Promise<boolean> => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      const state = get();
      if (!state.syncEnabled) {
        return false;
      }
      // H-16 keepalive：退出时浏览器可能取消异步请求，以 keepalive 语义透传底层 fetch。
      // 仅浏览器环境（window 存在）包装 globalThis/window.fetch 并在 finally 还原；
      // Node/桩环境（无 window）直接走基线透传，桩拦截不受影响。
      const fetchScope = globalThis as unknown as Record<string, unknown>;
      const originalFetch = fetchScope.fetch as typeof fetch | undefined;
      const originalWindowFetch =
        typeof window !== 'undefined'
          ? (window as unknown as Record<string, unknown>).fetch as typeof fetch | undefined
          : undefined;
      let keepalivePatched = false;
      if (typeof originalFetch === 'function' && typeof window !== 'undefined') {
        try {
          const keepaliveFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
            (originalFetch as (...args: unknown[]) => Promise<unknown>)(input, {
              ...((init as Record<string, unknown> | undefined) ?? {}),
              keepalive: true,
            })) as unknown as typeof fetch;
          fetchScope.fetch = keepaliveFetch;
          try {
            (window as unknown as Record<string, unknown>).fetch = keepaliveFetch;
          } catch {
            // 忽略只读 window.fetch，还原时以 globalThis 为准。
          }
          keepalivePatched = true;
        } catch {
          // 补丁失败则走基线透传，不阻断保存。
        }
      }
      try {
        // 中文注释：H-15 基线透传——保存时带上读取/落盘基线，成功后更新基线。
        const snapshot = toSnapshot(state.messages);
        const baselineAtSend = baselineMessageIds;
        await saveMyConversation(snapshot, baselineAtSend);
        baselineMessageIds = snapshot.map((message) => message.messageId);
        set({ saveError: null });
        return true;
      } catch (error) {
        // 中文注释：H-15 CONFLICT 不静默丢——置标记位＋toast＋initForUser 刷新。
        if (isConflictError(error)) {
          const reason = error instanceof Error ? error.message : String(error);
          set({ saveError: reason });
          showConflictToast();
          console.warn('[chatStore] flushPendingSave conflict', error);
          await refreshAfterConflict();
          return false;
        }
        const reason = error instanceof Error ? error.message : String(error);
        set({ saveError: reason });
        console.warn('[chatStore] flushPendingSave failed', error);
        return false;
      } finally {
        if (keepalivePatched) {
          try {
            fetchScope.fetch = originalFetch as typeof fetch;
          } catch {
            // 忽略还原失败。
          }
          try {
            if (typeof window !== 'undefined') {
              (window as unknown as Record<string, unknown>).fetch = originalWindowFetch as typeof fetch;
            }
          } catch {
            // 忽略还原失败。
          }
        }
      }
    })();
    flushInFlight = runFlush;
    try {
      return await runFlush;
    } finally {
      if (flushInFlight === runFlush) {
        flushInFlight = null;
      }

    }
  };

  return {
  messages: [],
  inputValue: '',
  hasUnviewedResponse: false,
  syncEnabled: false,
  saveError: null,
  pendingAutoSend: null,
  dispatch: (action: ChatStoreAction) => {
    set((state) => {
      const messages = [...state.messages];

      switch (action.type) {
        case 'user.submit': {
          // 预载续写标记来源：保留人工草稿并打标，渲染与落库时按标记隐藏指令泡。
          const submitOrigin: ChatMessageOrigin = action.origin ?? 'user';
          const userMsg = withPersona<ChatMessage>({
            id: createTempMessageId('user'),
            role: 'user',
            content: action.content,
            status: 'sending',
            createdAt: createTimestamp(),
            metadata: { origin: submitOrigin } as ChatMessage['metadata'],
          });
          const assistantBase = createAssistantPlaceholder();
          // M4-02 冻结语义：assistant message 创建 → message.id = X → createDraftArtifact({ sourceMessageId: X })。
          // 每个 attempt（assistant 消息）自带独立 draft，后续 chunk/complete 均按此 id 身份定位。
          // M4-03 快照冻结：同一 draft 内冻结本次生成开始时的 prompt 与 voice 快照；
          // prompt 缺省回退为本次 action.content；voice 由 chatFlow 传入实际生成请求所用 voice，缺省为 undefined。
          // promotion 时严禁重读 Settings，只消费此处冻结值；本步不自动触发 promotion。
          const submitPromptSnapshot =
            typeof action.promptSnapshot === 'string' ? action.promptSnapshot : action.content;
          const submitVoiceSnapshot =
            typeof action.voiceSnapshot === 'string' ? action.voiceSnapshot : undefined;
          const draft = createDraftArtifact({
            sourceMessageId: assistantBase.id,
            prompt: submitPromptSnapshot,
            voiceId: submitVoiceSnapshot,
          });
          const draftPart: StoryArtifactPart = { type: 'storyArtifact', artifact: draft };
          const assistantMsg = withPersona({
            ...assistantBase,
            content: '',
            parts: [draftPart],
            metadata: { ...assistantBase.metadata, origin: submitOrigin } as ChatMessage['metadata'],
          });
          if (submitOrigin === CHAT_PRELOAD_ORIGIN) {
            return {
              messages: [...messages, userMsg, assistantMsg],
            };
          }
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
          // M4-02：新 Attempt B 拥有全新 assistant id 与全新 draft；stale Attempt A 事件按旧 id 定位，绝不覆盖 B。
          // M4-03 快照冻结：retry 重建新 assistant/sourceMessageId，但 prompt 与本次实际使用的 voice 快照必须正确进入新 attempt；
          // prompt 缺省回退为配对失败 user 内容，voice 由 chatFlow 传入本次实际生成所用 voice；绝不等到 promotion 时再读 setting store。
          // 本步不自动触发 promotion。
          const retryPairedContent =
            typeof messages[lastIndex].content === 'string' ? messages[lastIndex].content : '';
          const retryPromptSnapshot =
            typeof action.promptSnapshot === 'string' ? action.promptSnapshot : retryPairedContent;
          const retryVoiceSnapshot =
            typeof action.voiceSnapshot === 'string' ? action.voiceSnapshot : undefined;
          const assistantBase = createAssistantPlaceholder();
          const draft = createDraftArtifact({
            sourceMessageId: assistantBase.id,
            prompt: retryPromptSnapshot,
            voiceId: retryVoiceSnapshot,
          });
          const draftPart: StoryArtifactPart = { type: 'storyArtifact', artifact: draft };
          const assistantMsg = withPersona({
            ...assistantBase,
            content: '',
            parts: [draftPart],
          });

          // 清理 lastIndex 之后的所有消息（假设它们是之前的失败尝试产生的垃圾）
          const newMessages = messages.slice(0, lastIndex + 1);
          newMessages.push(assistantMsg);

          return {
            messages: newMessages,
          };
        }
        case 'stream.delta': {
          // M4-02：按 attempt 身份定位；messageId 缺失时才回退最后一条 sending（legacy 兼容）。
          // stale/已清空（id 找不到）一律忽略，绝不复活、不污染其它 attempt。
          const targetIndex = findAssistantIndexById(messages, action.messageId);
          if (targetIndex === -1) return state;

          const msg = messages[targetIndex];
          const existingPart = getStoryArtifactPart(msg);
          if (existingPart) {
            // Modern 故事流：仅 draft 可追加；complete/interrupted 等终态忽略后续 delta（幂等）。
            if (!isDraftArtifact(existingPart.artifact)) {
              return state;
            }
            try {
              const updated = appendDraftChunk(existingPart.artifact, action.content);
              messages[targetIndex] = withArtifact(msg, updated);
            } catch {
              return state;
            }
            return { messages };
          }

          const newContent = msg.content + action.content;
          let newParts = msg.parts;
          if (newParts && newParts.length > 0) {
            const firstPart = newParts[0];
            if (firstPart.type === 'guidance') {
              newParts = [{ ...firstPart, content: newContent }, ...newParts.slice(1)];
            }
          }

          messages[targetIndex] = {
            ...msg,
            content: newContent,
            parts: newParts,
          };
          return { messages };
        }
        case 'stream.intent': {
          const targetIndex = findAssistantIndexById(messages, action.messageId);
          if (targetIndex === -1) return state;

          const msg = messages[targetIndex];
          const currentContent = msg.content;

          let agentType: AgentType | undefined;
          switch (action.intent) {
            case 'Story':
              agentType = 'story_agent';
              // M4-02：Story 意图确保 Modern draft 存在；绝不再创建 Legacy StoryCard。
              {
                const existing = getStoryArtifactPart(msg);
                if (!existing) {
                  // 历史 legacy 卡片只读保留：若已含 storyCard 则不覆盖，仅标记 agentType。
                  const hasLegacyCard = msg.parts?.some((p) => p.type === 'storyCard');
                  if (!hasLegacyCard) {
                    const draft = createDraftArtifact({
                      sourceMessageId: msg.id,
                      initialText: currentContent,
                    });
                    messages[targetIndex] = {
                      ...msg,
                      parts: [{ type: 'storyArtifact', artifact: draft } as StoryArtifactPart],
                      metadata: { ...msg.metadata, agentType },
                    };
                    return { messages };
                  }
                }
              }
              break;
            case 'Chat':
              agentType = 'chat_agent';
              break;
            case 'Guidance':
              agentType = 'guidance_agent';
              break;
          }

          if (agentType === 'story_agent') {
            messages[targetIndex] = {
              ...msg,
              metadata: { ...msg.metadata, agentType },
            };
            return { messages };
          }
          if (agentType === 'chat_agent') {
            // 非故事不持有 draft：清理空草稿，避免 Chat 污染 Artifact 视图。
            const filtered = msg.parts?.filter((p) => p.type !== 'storyArtifact');
            messages[targetIndex] = {
              ...msg,
              parts: filtered && filtered.length > 0 ? filtered : undefined,
              metadata: { ...msg.metadata, agentType },
            };
            return { messages };
          }
          if (agentType === 'guidance_agent') {
            const filtered = msg.parts?.filter((p) => p.type !== 'storyArtifact');
            const guidanceParts: MessagePart[] = [{
              type: 'guidance',
              content: currentContent,
            } as unknown as MessagePart];
            messages[targetIndex] = {
              ...msg,
              parts: [...guidanceParts, ...(filtered?.filter((p) => p.type !== 'guidance') ?? [])],
              metadata: { ...msg.metadata, agentType },
            };
            return { messages };
          }
          return { messages };
        }
        case 'stream.story_complete': {
          // M4-02 冻结语义：story_complete 仅表示故事正文 terminal（draft→complete）。
          // M4-04 编排：complete 随后同步进入 promoting 并 kick 唯一 async promotion
          // （complete → startPromotion() → promoteStoryArtifact()）；done 不再隐式 promotion。
          // 严格按 messageId 身份定位；找不到（stale/已清空）直接忽略，绝不复活。
          const targetIndex = messages.findIndex(
            (m) => m.id === action.messageId && m.role === 'assistant',
          );
          if (targetIndex === -1) return state;
          const msg = messages[targetIndex];
          const authoritativeText = (action.storyText ?? '').trim()
            ? (action.storyText as string)
            : (getStoryArtifactPart(msg)?.artifact.storyText ?? msg.content);
          if (!authoritativeText.trim()) return state;

          const existing = getStoryArtifactPart(msg);
          if (existing) {
            if (isCompleteArtifact(existing.artifact) || isPromotingArtifact(existing.artifact)) {
              // duplicate story_complete：同一 attempt 只发生一次 draft→complete→promoting，
              // 重复到达幂等忽略（绝不产生第二次入库写）。
              return state;
            }
            if (!isDraftArtifact(existing.artifact)) {
              // interrupted 等终态不接受 complete 覆盖。
              return state;
            }
            try {
              const completed = completeArtifact(existing.artifact, {
                finalStoryText: authoritativeText,
                title: action.title,
              });
              // 终态仍保持发送中/已送达原样，不在此标记 delivered（delivery 归 stream.finish）。
              writePromotingAndKick(messages, targetIndex, completed, action.messageId);
            } catch {
              return state;
            }
            return { messages };
          }
          // 无 Artifact 兜底：按同一 sourceMessageId 重建 draft→complete→promoting（仍不触达 audio）。
          try {
            const draft = createDraftArtifact({
              sourceMessageId: msg.id,
              initialText: msg.content,
            });
            const completed = completeArtifact(draft, {
              finalStoryText: authoritativeText,
              title: action.title,
            });
            writePromotingAndKick(messages, targetIndex, completed, action.messageId);
          } catch {
            return state;
          }
          return { messages };
        }
        case 'promotion.resolved': {
          // M4-04：promotion 成功回写 ready（promoting → ready）。
          // 归属校验失败（stale/epoch 失配/消息已清/Artifact 已非该次 promoting）一律 no-op。
          const claimed = claimPromotionSlot(messages, action.messageId, action.promotionToken, action.promotionEpoch);
          if (!claimed) return state;
          const promoting = getStoryArtifactPart(claimed.msg)?.artifact;
          if (!promoting || !isPromotingArtifact(promoting)) return state;
          try {
            const ready = finishPromotionAsReady(promoting, action.storyWorkId);
            messages[claimed.index] = withArtifact(claimed.msg, ready);
          } catch {
            // 非法 storyWorkId 等：不写回（slot 已释放，不重试、不抛）。
            return state;
          }
          return { messages };
        }
        case 'promotion.rejected': {
          // M4-04：promotion 失败回写 promotion_failed（promoting → promotion_failed）。
          // 完整 storyText / sourceMessageId / prompt / voice 快照全保留；delivery 不动；
          // 不换 sourceMessageId、不重生成、不自动重试（重试只走 promotion.retry）。
          const claimed = claimPromotionSlot(messages, action.messageId, action.promotionToken, action.promotionEpoch);
          if (!claimed) return state;
          const promoting = getStoryArtifactPart(claimed.msg)?.artifact;
          if (!promoting || !isPromotingArtifact(promoting)) return state;
          try {
            const failed = finishPromotionAsFailed(promoting, action.error ?? 'promotion_failed');
            messages[claimed.index] = withArtifact(claimed.msg, failed);
          } catch {
            return state;
          }
          return { messages };
        }
        case 'promotion.retry': {
          // M4-04：promotion_failed 幂等重试（promotion_failed → promoting ＋ 只重发入库写）。
          // 非 promotion_failed（promoting 在途/ready 终态/interrupted/draft/complete）一律忽略；
          // 同一 messageId 在途去重（快速双击只发一次）；绝不触达 generation transport。
          const targetIndex = messages.findIndex(
            (m) => m.id === action.messageId && m.role === 'assistant',
          );
          if (targetIndex === -1) return state;
          const msg = messages[targetIndex];
          const existing = getStoryArtifactPart(msg);
          if (!existing || !isPromotionFailedArtifact(existing.artifact)) return state;
          if (inflightPromotions.has(action.messageId)) return state;
          const source: PromotionFailedChatArtifact = existing.artifact;
          let promoting;
          try {
            promoting = beginPromotion(source);
          } catch {
            return state;
          }
          messages[targetIndex] = withArtifact(msg, promoting);
          enqueuePromotionKick(action.messageId, source);
          return { messages };
        }
        case 'stream.finish': {
          // M4-02：done 仅标记传输结束（sending→delivered），绝不隐式 complete/promotion/ready。
          // story_complete→done 仍是同一个 complete；done→story_complete 仍可随后 complete（不因 done 提前制造 ready）。
          // M4-02 fixup：只修改 paired user（assistantIndex 向前最近 user），旧 Attempt 不得污染其它 Attempt。
          const targetIndex = findAssistantIndexById(messages, action.messageId);
          if (targetIndex === -1) return state;

          const payload = action.payload as ChatStreamDoneEvent | undefined;
          messages[targetIndex] = {
            ...messages[targetIndex],
            status: messages[targetIndex].status === 'sending' ? 'delivered' : messages[targetIndex].status,
            metadata: {
              ...messages[targetIndex].metadata,
              ...(payload ? { finishReason: payload.finishReason, usage: payload.usage } : {}),
            },
          };

          // M4-02 fixup：仅配对 user sending→delivered（共用 findUserIndexForAssistant）。
          const pairedUserIndex = findUserIndexForAssistant(messages, targetIndex);
          if (pairedUserIndex !== -1 && messages[pairedUserIndex].status === 'sending') {
            messages[pairedUserIndex] = { ...messages[pairedUserIndex], status: 'delivered' };
          }

          return {
            messages,
            hasUnviewedResponse: true,
          };
        }
        case 'stream.fail': {
          // M4-02：error/abort → draft→interrupted，不出现 complete；按 id 定位，stale 直接忽略。
          // M4-02 fixup：只修改 paired user（共用 findUserIndexForAssistant），旧 Attempt 不得污染其它 Attempt。
          const targetIndex = findAssistantIndexById(messages, action.messageId);
          if (targetIndex !== -1) {
            const msg = messages[targetIndex];
            const existing = getStoryArtifactPart(msg);
            if (existing && isDraftArtifact(existing.artifact)) {
              try {
                const interrupted = interruptArtifact(existing.artifact, { reason: action.error ?? 'stream_error' });
                messages[targetIndex] = {
                  ...withArtifact(msg, interrupted),
                  status: 'failed',
                };
              } catch {
                messages[targetIndex] = { ...msg, status: 'failed' };
              }
            } else {
              messages[targetIndex] = { ...msg, status: 'failed' };
            }
          } else if (action.messageId) {
            // 带 id 却找不到：stale/已清空，绝不复活、不误伤其它 attempt。
            return state;
          } else {
            return state;
          }

          const pairedUserIndex = findUserIndexForAssistant(messages, targetIndex);
          if (pairedUserIndex !== -1 && messages[pairedUserIndex].status === 'sending') {
            messages[pairedUserIndex] = { ...messages[pairedUserIndex], status: 'failed' };
          }

          return { messages };
        }
        case 'stream.abort': {
          // M4-02 fixup：只修改 paired user（共用 findUserIndexForAssistant），旧 Attempt 不得污染其它 Attempt。
          const targetIndex = findAssistantIndexById(messages, action.messageId);
          if (targetIndex !== -1) {
            const msg = messages[targetIndex];
            const existing = getStoryArtifactPart(msg);
            if (existing && isDraftArtifact(existing.artifact)) {
              try {
                const interrupted = interruptArtifact(existing.artifact, { reason: action.reason ?? 'aborted' });
                messages[targetIndex] = {
                  ...withArtifact(msg, interrupted),
                  status: 'failed',
                };
              } catch {
                messages[targetIndex] = { ...msg, status: 'failed' };
              }
            } else {
              messages[targetIndex] = { ...msg, status: 'failed' };
            }
          } else if (action.messageId) {
            return state;
          } else {
            return state;
          }
          const pairedUserIndex = findUserIndexForAssistant(messages, targetIndex);
          if (pairedUserIndex !== -1 && messages[pairedUserIndex].status === 'sending') {
            messages[pairedUserIndex] = { ...messages[pairedUserIndex], status: 'failed' };
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
    // M4-04：drain 本次 dispatch 登记的 promotion kicks（set() 之后触发 async create）。
    drainPromotionKicks();
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
    // H-03-b：TRIGGER 计入排除预载指令泡（仅 origin === 'preload' 的 user 泡；预载故事助手卡仍计入/仍摘要）。
    const normalMessages = messages.slice(normalMessagesStartIndex).filter(m =>
      ['user', 'assistant'].includes(m.role) && m.metadata?.agentType !== 'summary_agent' && !isPreloadUserMessage(m as ChatMessage)
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
    // M4-04：同步作废在途 promotion（旧 resolve/reject 凭 epoch 失配 no-op）。
    invalidateInflightPromotions();
    set((state) => ({
      messages: state.messages.filter(m => m.status !== 'sending'),
    }));
    scheduleSave();
  },
  resetChat: () => {
    // M4-04：清空作废在途 promotion（旧 resolve/reject 凭 epoch 失配 no-op，绝不复活）。
    invalidateInflightPromotions();
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
      // 中文注释：H-15 读取成功记基线（内存，不持久化），供下次保存透传。
      baselineMessageIds = dtos.map((dto) => dto.messageId);
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
    // M4-04：登出同步作废在途 promotion（旧 resolve/reject 凭 epoch 失配 no-op）。
    invalidateInflightPromotions();
    userInitPromise = null; // 让重新登录能起新请求
    baselineMessageIds = undefined; // 中文注释：H-15 登出清基线，避免跨账号透传。
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    set({
      messages: [],
      inputValue: '',
      hasUnviewedResponse: false,
      syncEnabled: false,
      saveError: null,
    });
  },
  setInputValue: (nextValue) => {
    set({ inputValue: nextValue });
  },
  flushPendingSave,
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
        // Legacy 读 + Modern 读：历史 storyCard 与新 storyArtifact 均视为故事消息（只读，不新写）。
        if (msg.role === 'assistant' && msg.parts?.some((p) => p.type === 'storyCard' || p.type === 'storyArtifact')) {
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

      // 从当前消息的下一条开始查找助手消息（包含历史故事卡片；M4-02 起 Modern Artifact 无 audioUrl，天然返回 null）。
      // Legacy 只读保留，正式 cutover 放 M4-08。
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

      // H-03-b：历史轮次排预载指令泡，本轮保留供续写触发。
      // 仅最后一条 user（本轮触发，含预载“请继续故事”）原样保留，其余历史 isPreloadUserMessage 一律过滤；
      // 预载故事助手卡不受影响（仍进上下文/仍可摘要）。
      let lastUserIndex = -1;
      for (let index = effectiveMessages.length - 1; index >= 0; index--) {
        if (effectiveMessages[index].role === 'user') {
          lastUserIndex = index;
          break;
        }
      }
      const withoutHistoricalPreload = effectiveMessages.filter((message, index) => {
        if (index === lastUserIndex) {
          return true;
        }
        return !isPreloadUserMessage(message);
      });

      return mapMessagesToContext(withoutHistoricalPreload);
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
      // Legacy 读 + Modern 读：storyCard 历史与 storyArtifact（非空正文）均计为故事存在性（只读）。
      const isStoryMsg = (msg: (typeof messages)[number]) =>
        msg.role === 'assistant' &&
        (msg.parts?.some((p) => p.type === 'storyCard') ||
          msg.parts?.some(
            (p) => p.type === 'storyArtifact' && (p as StoryArtifactPart).artifact.storyText.trim() !== '',
          ));
      const targetIndex = excludeMessageId
        ? messages.findIndex((m) => m.id === excludeMessageId)
        : messages.length;

      if (targetIndex === -1) {
        // 如果没找到排除的消息，说明它可能还没加入列表，或者 ID 传错了。
        // 无妨，搜索整个列表。
        return messages.some(isStoryMsg);
      }

      // Search in messages before targetIndex
      return messages.slice(0, targetIndex).some(isStoryMsg);
    },
  },
  };
};

/**
 * 导出聊天 store 的 Hook，供组件按需选择字段使用。
 */
export const useChatStore = create<ChatStore>()(devtools(chatStoreCreator, { name: 'chat-store' }));

/**
 * 退出前落盘接线：页面卸载或隐藏时立即同步 pending 快照。
 * 与防抖保存共用 toSnapshot，失败由 flushPendingSave 置 saveError 标记位，不静默丢。
 * SSR/Node 下无 window 时跳过注册。
 */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const handleChatExitFlush = () => {
    useChatStore.getState().flushPendingSave().catch(() => {
      // 中文注释：失败已由 saveError 标记位记录，此处仅防未处理拒绝。
    });
  };
  window.addEventListener('beforeunload', handleChatExitFlush);
  window.addEventListener('pagehide', handleChatExitFlush);
}
