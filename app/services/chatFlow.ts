import { useChatStore } from '@/stores/chatStore';
import { useGenerationStore } from '@/stores/generationStore';
import type { ChatConversationMessage } from '@/types/chat';
import { interactWithAgent, type AgentMessage } from './agentFlow';
import { startStoryPlayback } from './storyFlow';

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
 * 执行一次聊天流式调用，根据流事件更新 store。
 * @param context 即将发送给后端的对话上下文。
 * @returns 包含最终音频地址和生成内容的对象
 */
const executeChatStream = async (context: ChatConversationMessage[]): Promise<{ audioUrl: string; content: string }> => {
  const generationStore = useGenerationStore.getState();
  const abortController = new AbortController();
  useChatStore.getState().setAbortController(abortController);

  let streamErrored = false;
  let lastErrorMessage: string | undefined;

  // 转换 ChatConversationMessage 到 AgentMessage
  const agentMessages = context as unknown as AgentMessage[];

  try {
    let audioUrl: string = '';
    let generatedContent: string = '';

    // 2. 重置状态并设置生成文本阶段
    generationStore.reset();
    generationStore.setPhase('generating_text');

    await interactWithAgent(
      agentMessages,
      {
        onTextDelta: (delta) => {
          // 同步更新 UI 状态
          generationStore.appendText(delta);
          // 同步更新 Chat 消息
          useChatStore.getState().appendAssistantDelta(delta);
          // 累积生成内容
          generatedContent += delta;
        },
        onIntentDetected: (intent) => {
          if (intent === "Story") {
            generationStore.setPhase('generating_text');
          }
          useChatStore.getState().switchAssistantMessageType(intent);
        },
        onAgentActive: (name) => {
          // 将英文名转换为更友好的中文显示
          const displayNames: Record<string, string> = {
            "StoryAgent": "故事作家",
            "ChatAgent": "聊天助手",
            "GuidanceAgent": "系统指令",
          };
          const displayName = displayNames[name] || name;
          useChatStore.getState().setAssistantDisplayName(displayName);
        },
        onAudioStart: () => {
          generationStore.setPhase('generating_audio');
        },
        onAudioComplete: (url) => {
          audioUrl = url;
        },
        onComplete: () => {
          // 3. 生成完成 & 更新 ChatStore
          generationStore.setPhase('ready');

          if (!streamErrored) {
            if (audioUrl) {
              // 如果收到了音频，作为故事消息完成
              // 1. 获取完成前的消息列表（不含当前正在生成的这条，因为它还在 activeAssistantMessage 暂存态）
              const messages = useChatStore.getState().messages;

              // 2. 检查历史中是否存在故事消息
              const hasPriorStories = messages.some(msg =>
                msg.role === 'assistant' && msg.parts?.some(p => p.type === 'storyCard')
              );

              const currentContent = useChatStore.getState().activeAssistantMessage?.content || "";
              useChatStore.getState().finalizeStoryMessage({
                storyText: currentContent,
                audioUrl,
              });

              // 3. 仅当历史中没有故事时，才自动播放
              if (!hasPriorStories) {
                // 需要获取刚刚 finalize 写入后的最新消息 ID，或者直接从 activeAssistantMessage 取 ID
                // finalizeStoryMessage 会把 activeAssistantMessage 放入 messages，ID 不变
                const messageId = useChatStore.getState().messages.slice(-1)[0].id;
                startStoryPlayback(messageId, audioUrl).catch(console.error);
              }
            } else {
              // 否则作为普通助手消息完成
              useChatStore.getState().finalizeAssistantMessage({ type: 'done', finishReason: 'stop' });
            }
          }
        },
        onError: (error) => {
          streamErrored = true;
          lastErrorMessage = error.message;
          useChatStore.getState().markFailure();
        },
      },
      abortController.signal
    );

    if (streamErrored) {
      throw new Error(lastErrorMessage ?? '聊天请求失败，请稍后再试');
    }

    return { audioUrl, content: generatedContent };
  } catch (error) {
    useChatStore.getState().setAbortController(null);
    if (error instanceof DOMException && error.name === 'AbortError') {
      useChatStore.getState().resetActiveSession();

      throw error;
    }
    if (!streamErrored) {
      useChatStore.getState().markFailure();
    }
    const normalized = normalizeError(error);
    throw normalized;
  } finally {
    // 总是清理 Controller
    useChatStore.getState().setAbortController(null);
  }
};

/**
 * 开启新的聊天流式请求：准备上下文并发起调用。
 * @param content 用户输入的文本内容。
 * @returns 包含生成的消息 ID 和音频 URL
 */
export const beginChatStream = async (content: string): Promise<{ messageId: string; audioUrl: string; content: string }> => {
  const { context, assistantMessage } = useChatStore.getState().prepareNewSubmission(content);
  const { audioUrl, content: generatedContent } = await executeChatStream(context);
  return { messageId: assistantMessage.id, audioUrl, content: generatedContent };
};

/**
 * 重试最近一条失败的消息，再次触发流式流程。
 */
export const retryChatStream = async (): Promise<void> => {
  const state = useChatStore.getState();
  if (!state.pendingMessage || state.pendingMessage.status !== 'failed') {
    throw new Error('当前没有需要重试的消息');
  }
  const { context } = state.prepareRetrySubmission();
  await executeChatStream(context);
};

/**
 * 主动取消当前的聊天流式请求并清理状态。
 */
export const cancelChatStream = () => {
  const controller = useChatStore.getState().currentAbortController;
  if (controller) {
    controller.abort();
  }
  useChatStore.getState().resetActiveSession();
  useChatStore.getState().setAbortController(null);
};
