import { useChatStore } from '@/stores/chatStore';
import type { ChatMessageOrigin } from '@/stores/chatStore';
import { useGenerationStore } from '@/stores/generationStore';
import { useConfigStore } from '@/stores/configStore';
import type { ChatConversationMessage } from '@/types/chat';
import type { AgentMessage } from '@/types/agent';
import { interactWithAgent } from './agentFlow';
import { autoplayDraftStory } from './playbackSessionFlow';

/**
 * 将未知异常标准化为 Error，便于上层展示 Toast。
 * @param error 捕获到的未知异常。
 */
const normalizeError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }
  return new Error('聊天请求失败，请稍后再试');
};

/**
 * 全局的 AbortController，用于管理当前进行中的请求。
 * 确保同一时间只有一个活跃的聊天请求，避免竞态问题。
 */
let globalAbortController: AbortController | null = null;

/**
 * M9-C1 T2 评审闭合：聊天流运行代次。
 *
 * 每次新开流或显式中止自增。`onComplete` 的异步 autoplay IIFE 在落盘 await 后会
 * 复核代次：若期间发生 abort/新建创作/登出，则放弃起播，旧故事绝不复活。
 */
let streamSeq = 0;

/**
 * 执行一次聊天流式调用，根据流事件更新 store。
 * M4-02：全链路按 assistantMessageId（attempt 身份）定位 Artifact；
 * story_complete 仅完成正文（draft→complete），done 仅标记 delivered，音频仅瞬态播放不写入消息。
 * @param context 即将发送给后端的对话上下文。
 * @param assistantMessageId 本次 attempt 的助手消息 id（sourceMessageId 同值）。
 * @returns 包含最终音频地址和生成内容的对象
 */
const executeChatStream = async (
  context: ChatConversationMessage[],
  assistantMessageId: string,
  frozenVoiceId?: string,
): Promise<{ audioUrl: string; content: string }> => {
  const generationStore = useGenerationStore.getState();

  // 确保清理上一个控制器，防止残留的请求继续占用资源
  if (globalAbortController) {
    globalAbortController.abort();
  }
  globalAbortController = new AbortController();
  const myStreamSeq = ++streamSeq;

  let streamErrored = false;
  let lastErrorMessage: string | undefined;

  // 转换 ChatConversationMessage 到 AgentMessage：role 已收敛为同集，content 强制为字符串
  const agentMessages: AgentMessage[] = context.map((message) => ({
    role: message.role,
    content: typeof message.content === 'string' ? message.content : '',
  }));

  try {
    // 瞬态音频 Blob（仅用于播放，不写入 Chat 消息/Artifact；M4-02 起消息层 audioUrl write = 0）。
    let pendingAudioBlob: string = '';
    let generatedContent: string = '';

    // 重置状态并设置生成文本阶段
    generationStore.reset();
    generationStore.setPhase('generating_text');

    // 获取当前配置
    // M4-03 快照冻结：实际生成请求所使用的 voice 即 frozenVoiceId（由 begin/retry 在 dispatch 前单次捕获并同时写入 draft）；
    // 此处优先使用传入快照，缺省才回读 Settings，确保 draft 冻结值与真实请求用值恒等，且 promotion 绝不重读 Settings。
    const { speed } = useConfigStore.getState().apiConfig;
    const voiceId = typeof frozenVoiceId === 'string' ? frozenVoiceId : useConfigStore.getState().apiConfig.voiceId;
    const agentConfig = {
      audio: {
        speed,
        voiceId,
      },
    };

    await interactWithAgent(
      agentMessages,
      {
        onTextDelta: (delta) => {
          // 同步更新 UI 状态
          generationStore.appendText(delta);
          // M4-02：按 attempt 身份追加（draft→draft），stale 直接忽略。
          useChatStore.getState().dispatch({ type: 'stream.delta', content: delta, messageId: assistantMessageId });
          // 累积生成内容
          generatedContent += delta;
        },
        onIntentDetected: (intent) => {
          if (intent === "Story") {
            generationStore.setPhase('generating_text');
          }
          useChatStore.getState().dispatch({ type: 'stream.intent', intent, messageId: assistantMessageId });
        },
        onStoryComplete: (storyText) => {
          // M4-02 冻结语义：故事正文 terminal → draft→complete（仅正文，不触达音频/promotion）。
          generatedContent = storyText;
          useChatStore.getState().dispatch({
            type: 'stream.story_complete',
            messageId: assistantMessageId,
            storyText,
          });
        },
        onAudioStart: () => {
          generationStore.setPhase('generating_audio');
        },
        onAudioComplete: (url) => {
          pendingAudioBlob = url;
        },
        onComplete: () => {
          // M4-02：done 仅标记传输结束，绝不隐式 promotion；音频仅在消息仍存在时瞬态播放。
          generationStore.setPhase('ready');

          if (!streamErrored) {
            const stillExists = useChatStore
              .getState()
              .messages.some((m) => m.id === assistantMessageId);
            // done 与 story_complete 解耦：无论有无音频，一律只标记 delivered（Artifact 原样保留）。
            useChatStore.getState().dispatch({
              type: 'stream.finish',
              payload: { type: 'done', finishReason: 'stop' },
              messageId: assistantMessageId,
            });

            if (stillExists && pendingAudioBlob) {
              // 仅当历史中没有故事时（即首次生成故事），才自动开始播放；清空后消息已不存在则绝不孤儿播放。
              const existingStories = useChatStore
                .getState()
                .selectors.hasStoryMessages(assistantMessageId);
              if (!existingStories) {
                // M9-F01：autoplay 经正式 Draft Session（先落盘保证 ChatMessage 行存在，
                // 再 begin+provider 起播；旧整篇 blob 无 segment identity 不得当 paragraph
                // 播放，一律吊销丢弃）。失败则 fail-closed 静默（聊天持久化本身亦已失败）。
                // onComplete 是同步回调，落盘/起播链经 async IIFE 串行，不阻塞流收尾。
                void (async () => {
                  try {
                    await useChatStore.getState().flushPendingSave().catch(() => false);
                  } catch {
                    // 落盘失败不阻断 begin 尝试（行可能已存在）；begin 侧自行 fail-closed。
                  }
                  // M9-C1 T2 评审闭合：落盘 await 期间若发生 abort/新流/强重置（代次变化）
                  // 或消息已被清空，则绝不复活旧故事起播，仅吊销 Blob。
                  const revoked = () => {
                    try {
                      if (typeof pendingAudioBlob === 'string' && pendingAudioBlob.startsWith('blob:')) {
                        URL.revokeObjectURL(pendingAudioBlob);
                      }
                    } catch {
                      // 吊销失败不影响播放链。
                    }
                  };
                  if (myStreamSeq !== streamSeq) {
                    revoked();
                    return;
                  }
                  if (!useChatStore.getState().messages.some((m) => m.id === assistantMessageId)) {
                    revoked();
                    return;
                  }
                  autoplayDraftStory({
                    messageId: assistantMessageId,
                    storyText: generatedContent,
                  }).catch(console.error);
                  revoked();
                })();
              }
            } else if (stillExists) {
              // 无音频的普通对话同样已在上标记 delivered，无需额外分支。
            }

            // 触发历史总结检查 (异步执行，不阻塞 UI)
            useChatStore.getState().checkAndSummarize().catch(console.error);
          }
        },
        onError: (error) => {
          streamErrored = true;
          lastErrorMessage = error.message;
          useChatStore.getState().dispatch({ type: 'stream.fail', error: error.message, messageId: assistantMessageId });
        },
      },
      globalAbortController.signal,
      agentConfig
    );

    if (streamErrored) {
      throw new Error(lastErrorMessage ?? '聊天请求失败，请稍后再试');
    }

    return { audioUrl: pendingAudioBlob, content: generatedContent };
  } catch (error) {
    globalAbortController = null;
    if (error instanceof DOMException && error.name === 'AbortError') {
      // M4-02：abort 按身份中断 draft→interrupted，不复活、不污染其它 attempt。
      useChatStore.getState().dispatch({ type: 'stream.abort', messageId: assistantMessageId, reason: 'aborted' });

      throw error;
    }
    if (!streamErrored) {
      useChatStore.getState().dispatch({ type: 'stream.fail', error: String(error), messageId: assistantMessageId });
    }
    const normalized = normalizeError(error);
    throw normalized;
  } finally {
    // 无论成功或失败，请求结束时总是释放 Controller 引用
    globalAbortController = null;
  }
};

/**
 * 开启新的聊天流式请求：准备上下文并发起调用。
 * @param content 用户输入的文本内容。
 * @param options.origin 消息来源（连续创作续写传 'preload'，用于隔离用户草稿与可见气泡）。
 * @returns 包含生成的消息 ID 和音频 URL
 */
export const beginChatStream = async (
  content: string,
  options?: { origin?: ChatMessageOrigin },
): Promise<{ messageId: string; audioUrl: string; content: string }> => {
  // M4-03 快照冻结：在生成开始前单次捕获实际请求所用 voice，并与 prompt 一同冻结进 draft；
  // 同一快照透传给 executeChatStream，确保 draft 冻结值与真实请求用值恒等；promotion 严禁重读 Settings。
  const frozenVoiceId = useConfigStore.getState().apiConfig.voiceId;
  // 1. 提交用户消息（含本次 prompt/voice 快照）
  useChatStore.getState().dispatch({
    type: 'user.submit',
    content,
    origin: options?.origin,
    promptSnapshot: content,
    voiceSnapshot: frozenVoiceId,
  });

  // 2. 获取上下文消息列表
  const context = useChatStore.getState().selectors.conversationMessages();

  // 获取刚刚创建的助手消息 ID (为最后一条消息，此时处于 sending 状态)
  const assistantMsgId = useChatStore.getState().selectors.latestMessage()?.id;

  // 3. 执行流
  if (assistantMsgId) {
    const { audioUrl, content: generatedContent } = await executeChatStream(
      context,
      assistantMsgId,
      frozenVoiceId,
    );
    return { messageId: assistantMsgId, audioUrl, content: generatedContent };
  }
  throw new Error('Failed to create assistant message');
};

/**
 * M9-C1 T2：新建创作强重置时中止在途聊天流。
 *
 * 仅中止当前 transport；epoch 递增由调用方先行完成，旧回调凭 epoch no-op，
 * 因此本函数不额外处理 stale 回写。
 */
export const abortActiveChatStream = (): void => {
  streamSeq += 1;
  if (globalAbortController) {
    globalAbortController.abort();
    globalAbortController = null;
  }
};

/**
 * 重试最近一条失败的消息，再次触发流式流程。
 */
export const retryChatStream = async (): Promise<void> => {
  const lastFailed = useChatStore.getState().selectors.latestFailedMessage();
  if (!lastFailed) {
    throw new Error('当前没有需要重试的消息');
  }

  // M4-03 快照冻结：retry 重建新 assistant/sourceMessageId，但本次实际使用的 prompt/voice 必须进入新 attempt；
  // voice 在 dispatch 前单次捕获，prompt 取配对失败 user 内容（与 chatStore 回退一致），二者显式传入，不等 promotion 时再读 store。
  const failedMessages = useChatStore.getState().messages;
  const lastFailedUser = [...failedMessages]
    .reverse()
    .find((m) => m.role === 'user' && m.status === 'failed');
  const retryPromptSnapshot =
    typeof lastFailedUser?.content === 'string' ? lastFailedUser.content : undefined;
  const retryVoiceSnapshot = useConfigStore.getState().apiConfig.voiceId;

  // 1. 触发重试 Action（含本次 prompt/voice 快照）
  useChatStore.getState().dispatch({
    type: 'user.retry',
    promptSnapshot: retryPromptSnapshot,
    voiceSnapshot: retryVoiceSnapshot,
  });

  // 2. 获取上下文
  const context = useChatStore.getState().selectors.conversationMessages();

  // 3. 执行流：按新 Attempt 身份执行，stale 旧事件不得覆盖。
  const retryAssistantId = useChatStore.getState().selectors.latestAssistantMessage()?.id;
  if (!retryAssistantId) {
    throw new Error('Failed to create assistant message');
  }
  await executeChatStream(context, retryAssistantId, retryVoiceSnapshot);
};
