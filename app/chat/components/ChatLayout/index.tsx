'use client';

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Toast } from 'antd-mobile';

import { beginChatStream, cancelChatStream, retryChatStream } from '@/app/services/chatFlow';
import { useChatStore } from '@/stores/chatStore';

import InputArea from './InputArea';
import MessageArea from './MessageArea';
import styles from './index.module.scss';
import type { ChatLayoutProps } from './types';

/**
 * 聊天页面布局组件，组织消息区与输入区。
 * @param props.initialMessages 初始消息列表。
 * @returns 布局结构 JSX。
 */
const ChatLayout: React.FC<ChatLayoutProps> = ({ initialMessages }) => {
  /** 记录是否已经完成 store 初始化，避免重复写入。 */
  const hasHydratedRef = useRef(false);

  const messages = useChatStore((state) => state.messages);
  const pendingMessage = useChatStore((state) => state.pendingMessage);
  const activeAssistantMessage = useChatStore((state) => state.activeAssistantMessage);

  /** 是否存在发送中的消息，用于控制输入区禁用状态。 */
  const isSending = useMemo(
    () => pendingMessage?.status === 'sending' || Boolean(activeAssistantMessage),
    [pendingMessage?.status, activeAssistantMessage],
  );

  /** 将 store 与初始消息融合，避免首屏出现空白。 */
  const resolvedMessages = useMemo(() => {
    if (!hasHydratedRef.current && messages.length === 0) {
      return initialMessages;
    }
    return messages;
  }, [initialMessages, messages]);

  useEffect(() => {
    if (hasHydratedRef.current) {
      return;
    }
    useChatStore.getState().hydrateInitialMessages(initialMessages);
    hasHydratedRef.current = true;
  }, [initialMessages]);

  useEffect(() => {
    return () => {
      cancelChatStream();
    };
  }, []);

  /**
   * 输入区提交回调，触发聊天流式流程。
   * @param content 用户输入的文本内容。
   */
  const handleSubmit = useCallback(async (content: string) => {
    await beginChatStream(content);
  }, []);

  /**
   * 处理失败消息的重试逻辑，确保仅在待重试的消息上触发。
   * @param retryId 触发重试的消息 id。
   */
  const handleRetry = useCallback(async (retryId?: string) => {
    const currentPending = useChatStore.getState().pendingMessage;
    if (!currentPending || currentPending.id !== retryId) {
      return;
    }
    try {
      await retryChatStream();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '重试失败，请稍后再试';
      Toast.show({ icon: 'fail', content: message });
    }
  }, []);

  return (
    <div className={styles.chatLayout}>
      <MessageArea
        messages={resolvedMessages}
        pendingMessage={pendingMessage}
        streamingMessage={activeAssistantMessage}
        isLoading={false}
        onRetry={handleRetry}
      />
      <InputArea onSubmit={handleSubmit} disabled={isSending} isSending={isSending} />
    </div>
  );
};

export default ChatLayout;
