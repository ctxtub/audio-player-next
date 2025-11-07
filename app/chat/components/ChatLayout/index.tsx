"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import InputArea from './InputArea';
import MessageArea from './MessageArea';
import styles from './index.module.scss';
import type { ChatLayoutProps } from './types';
import type { ChatMessage, ChatPendingMessage } from '../ChatLog/types';

/**
 * 聊天页面布局组件，组织头部信息、消息区与输入区。
 * @param props.userNickname 当前用户昵称。
 * @param props.conversationId 当前会话 ID，可为空。
 * @param props.initialMessages 初始消息列表。
 * @returns 布局结构 JSX。
 */
const ChatLayout: React.FC<ChatLayoutProps> = ({
  userNickname,
  conversationId,
  initialMessages,
}) => {
  /** 已确认写入的历史消息列表。 */
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  /** 待发送或发送中的消息占位，用于展示发送进度。 */
  const [pendingMessage, setPendingMessage] = useState<ChatPendingMessage | null>(null);
  /** 历史记录是否加载中的标记，预留后续数据对接。 */
  const [isHistoryLoading] = useState(false);
  /** 用户消息写入的延时定时器引用，便于卸载时清理。 */
  const submitTimerRef = useRef<number | null>(null);
  /** 助手自动回复的定时器引用，用于模拟异步响应。 */
  const replyTimerRef = useRef<number | null>(null);

  /** 组件卸载时清理未完成的定时器，避免内存泄漏。 */
  useEffect(() => {
    return () => {
      if (submitTimerRef.current) {
        clearTimeout(submitTimerRef.current);
      }
      if (replyTimerRef.current) {
        clearTimeout(replyTimerRef.current);
      }
    };
  }, []);

  /**
   * 将用户输入的消息写入正式列表，并触发模拟助手回复。
   * @param content 用户提交的文本内容。
   * @param tempId 临时消息标识。
   * @returns 完成写入后的 Promise，用于与输入组件衔接状态。
   */
  const sendMessage = useCallback(
    (content: string, tempId: string) =>
      new Promise<void>((resolve) => {
        if (submitTimerRef.current) {
          clearTimeout(submitTimerRef.current);
        }
        submitTimerRef.current = window.setTimeout(() => {
          setMessages((prev) => [
            ...prev,
            {
              id: tempId,
              role: 'user',
              content,
              status: 'delivered',
              createdAt: new Date().toISOString(),
            },
          ]);
          setPendingMessage(null);
          submitTimerRef.current = null;
          resolve();

          if (replyTimerRef.current) {
            clearTimeout(replyTimerRef.current);
          }
          replyTimerRef.current = window.setTimeout(() => {
            setMessages((prev) => [
              ...prev,
              {
                id: `assistant-${Date.now()}`,
                role: 'assistant',
                content: `收到啦！我们会尽快为你安排故事：“${content}”`,
                status: 'delivered',
                createdAt: new Date().toISOString(),
              },
            ]);
            replyTimerRef.current = null;
          }, 600);
        }, 400);
      }),
    [],
  );

  /**
   * 输入区提交回调，负责生成临时消息并触发发送流程。
   * @param content 用户输入的文本内容。
   */
  const handleSubmit = useCallback(
    async (content: string) => {
      const tempId = `local-${Date.now()}`;
      setPendingMessage({
        id: tempId,
        role: 'user',
        content,
        status: 'sending',
      });
      await sendMessage(content, tempId);
    },
    [sendMessage],
  );

  /**
   * 重试失败消息时沿用统一的提交流程。
   * @param retryId 需要重试的消息标识。
   */
  const handleRetry = useCallback(
    (retryId?: string) => {
      if (!pendingMessage || pendingMessage.id !== retryId) {
        return;
      }
      setPendingMessage({ ...pendingMessage, status: 'sending' });
      const tempId = retryId ?? pendingMessage.id ?? `local-${Date.now()}`;
      void sendMessage(pendingMessage.content, tempId);
    },
    [pendingMessage, sendMessage],
  );

  /** 当前是否存在发送中的消息，用于禁用输入框。 */
  const isSending = useMemo(
    () => pendingMessage?.status === 'sending',
    [pendingMessage?.status],
  );

  return (
    <div className={styles.chatLayout}>
      <header className={styles.header}>
        <div className={styles.headerMeta}>
          <div className={styles.headerMetaRow}>
            <span className={styles.headerMetaLabel}>当前用户</span>
            <span className={styles.headerMetaValue}>{userNickname}</span>
          </div>
          <div className={styles.headerMetaRow}>
            <span className={styles.headerMetaLabel}>会话标识</span>
            <span className={styles.headerMetaValue}>{conversationId ?? '待创建'}</span>
          </div>
        </div>
      </header>
      <MessageArea
        messages={messages}
        pendingMessage={pendingMessage}
        isLoading={isHistoryLoading}
        onRetry={handleRetry}
      />
      <InputArea
        onSubmit={handleSubmit}
        disabled={isSending}
        isSending={isSending}
      />
    </div>
  );
};

export default ChatLayout;
