import { createChatStreamClient, ChatStreamError } from '@/lib/client/chatStream';
import { useChatStore } from '@/stores/chatStore';
import type { ChatConversationMessage } from '@/types/chat';

/**
 * 聊天客户端单例，用于复用底层 fetch 与解析逻辑。
 */
const chatStreamClient = createChatStreamClient();

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
 */
const executeChatStream = async (context: ChatConversationMessage[]): Promise<void> => {
  const abortController = new AbortController();
  useChatStore.getState().setAbortController(abortController);

  let streamErrored = false;
  let lastErrorMessage: string | undefined;

  try {
    await chatStreamClient.startStream(
      {
        messages: context,
      },
      {
        signal: abortController.signal,
        onEvent: (event) => {
          if (event.type === 'message') {
            useChatStore.getState().appendAssistantDelta(event.delta);
            return;
          }
          if (event.type === 'error') {
            streamErrored = true;
            lastErrorMessage =
              event.code === 'STREAM_UNEXPECTED_EOF'
                ? '聊天通道在未完成时断开，请重试'
                : event.message;
            useChatStore.getState().markFailure();
            return;
          }
          if (event.finishReason === 'error') {
            streamErrored = true;
            lastErrorMessage = '聊天生成失败，请稍后重试';
            useChatStore.getState().markFailure();
            return;
          }

          const assistantMessage = useChatStore.getState().activeAssistantMessage;
          if (!assistantMessage || !assistantMessage.content.trim()) {
            streamErrored = true;
            lastErrorMessage = '助手没有返回有效内容，请重试';
            useChatStore.getState().markFailure();
            return;
          }

          if (!streamErrored) {
            useChatStore.getState().finalizeAssistantMessage(event);
          }
        },
      },
    );
    if (streamErrored) {
      throw new Error(lastErrorMessage ?? '聊天请求失败，请稍后再试');
    }
  } catch (error) {
    useChatStore.getState().setAbortController(null);
    if (error instanceof DOMException && error.name === 'AbortError') {
      useChatStore.getState().resetActiveSession();
      return;
    }
    if (!streamErrored) {
      useChatStore.getState().markFailure();
    }
    const normalized = error instanceof ChatStreamError ? new Error(error.message) : normalizeError(error);
    throw normalized;
  } finally {
    useChatStore.getState().setAbortController(null);
  }
};

/**
 * 开启新的聊天流式请求：准备上下文并发起调用。
 * @param content 用户输入的文本内容。
 */
export const beginChatStream = async (content: string): Promise<void> => {
  const { context } = useChatStore.getState().prepareNewSubmission(content);
  await executeChatStream(context);
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
