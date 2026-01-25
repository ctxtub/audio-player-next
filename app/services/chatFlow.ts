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
 * 全局的 AbortController，用于管理当前进行中的请求。
 * 确保同一时间只有一个活跃的聊天请求，避免竞态问题。
 */
let globalAbortController: AbortController | null = null;

/**
 * 执行一次聊天流式调用，根据流事件更新 store。
 * @param context 即将发送给后端的对话上下文。
 * @returns 包含最终音频地址和生成内容的对象
 */
const executeChatStream = async (context: ChatConversationMessage[]): Promise<{ audioUrl: string; content: string }> => {
  const generationStore = useGenerationStore.getState();

  // 确保清理上一个控制器，防止残留的请求继续占用资源
  if (globalAbortController) {
    globalAbortController.abort();
  }
  globalAbortController = new AbortController();

  let streamErrored = false;
  let lastErrorMessage: string | undefined;

  // 转换 ChatConversationMessage 到 AgentMessage
  const agentMessages = context as unknown as AgentMessage[];

  try {
    let audioUrl: string = '';
    let generatedContent: string = '';

    // 重置状态并设置生成文本阶段
    generationStore.reset();
    generationStore.setPhase('generating_text');

    await interactWithAgent(
      agentMessages,
      {
        onTextDelta: (delta) => {
          // 同步更新 UI 状态
          generationStore.appendText(delta);
          // 同步更新 Chat 消息
          useChatStore.getState().dispatch({ type: 'stream.delta', content: delta });
          // 累积生成内容
          generatedContent += delta;
        },
        onIntentDetected: (intent) => {
          if (intent === "Story") {
            generationStore.setPhase('generating_text');
          }
          useChatStore.getState().dispatch({ type: 'stream.intent', intent });
        },
        onAgentActive: (name) => {
          // 将英文名转换为更友好的中文显示
          const displayNames: Record<string, string> = {
            "StoryAgent": "故事作家",
            "ChatAgent": "聊天助手",
            "GuidanceAgent": "系统指令",
          };
          const displayName = displayNames[name] || name;
          useChatStore.getState().dispatch({ type: 'stream.persona', name: displayName });
        },
        onAudioStart: () => {
          generationStore.setPhase('generating_audio');
        },
        onAudioComplete: (url) => {
          audioUrl = url;
        },
        onComplete: () => {
          // 生成完成 & 更新 ChatStore
          generationStore.setPhase('ready');

          if (!streamErrored) {
            if (audioUrl) {
              // 如果收到了音频，作为故事消息完成
              // 2. 检查上下文中是否存在历史故事 (用于判断是否自动播放)。
              // 注意：需排除当前刚刚生成的这一条。
              const lastMsg = useChatStore.getState().selectors.latestMessage();
              const existingStories = useChatStore.getState().selectors.hasStoryMessages(lastMsg?.id);

              // 此时 generatedContent 已累积了完整内容，直接使用确保一致性
              useChatStore.getState().dispatch({
                type: 'stream.story_finish',
                storyText: generatedContent,
                audioUrl,
              });

              // 3. 仅当历史中没有故事时（即首次生成故事），才自动开始播放。
              if (!existingStories && lastMsg) {
                startStoryPlayback(lastMsg.id, audioUrl).catch(console.error);
              }
            } else {
              // 若无音频 URL，则按照普通对话消息结束流程
              useChatStore.getState().dispatch({
                type: 'stream.finish',
                payload: { type: 'done', finishReason: 'stop' }
              });
            }
          }
        },
        onError: (error) => {
          streamErrored = true;
          lastErrorMessage = error.message;
          useChatStore.getState().dispatch({ type: 'stream.fail', error: error.message });
        },
      },
      globalAbortController.signal
    );

    if (streamErrored) {
      throw new Error(lastErrorMessage ?? '聊天请求失败，请稍后再试');
    }

    return { audioUrl, content: generatedContent };
  } catch (error) {
    globalAbortController = null;
    if (error instanceof DOMException && error.name === 'AbortError') {
      useChatStore.getState().resetActiveSession();

      throw error;
    }
    if (!streamErrored) {
      useChatStore.getState().dispatch({ type: 'stream.fail', error: String(error) });
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
 * @returns 包含生成的消息 ID 和音频 URL
 */
export const beginChatStream = async (content: string): Promise<{ messageId: string; audioUrl: string; content: string }> => {
  // 1. 提交用户消息
  useChatStore.getState().dispatch({ type: 'user.submit', content });

  // 2. 获取上下文消息列表
  const context = useChatStore.getState().selectors.conversationMessages();

  // 获取刚刚创建的助手消息 ID (为最后一条消息，此时处于 sending 状态)
  const assistantMsgId = useChatStore.getState().selectors.latestMessage()?.id;

  // 3. 执行流
  if (assistantMsgId) {
    const { audioUrl, content: generatedContent } = await executeChatStream(context);
    return { messageId: assistantMsgId, audioUrl, content: generatedContent };
  }
  throw new Error('Failed to create assistant message');
};

/**
 * 重试最近一条失败的消息，再次触发流式流程。
 */
export const retryChatStream = async (): Promise<void> => {
  const lastFailed = useChatStore.getState().selectors.latestFailedMessage();
  if (!lastFailed) {
    throw new Error('当前没有需要重试的消息');
  }

  // 1. 触发重试 Action
  useChatStore.getState().dispatch({ type: 'user.retry' });

  // 2. 获取上下文
  const context = useChatStore.getState().selectors.conversationMessages();

  // 3. 执行流
  await executeChatStream(context);
};

/**
 * 主动取消当前的聊天流式请求并清理状态。
 */
export const cancelChatStream = () => {
  if (globalAbortController) {
    globalAbortController.abort();
    globalAbortController = null;
  }
  useChatStore.getState().resetActiveSession();
};
