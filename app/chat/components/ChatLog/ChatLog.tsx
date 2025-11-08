'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import MessageBubble from './MessageBubble';
import styles from './ChatLog.module.scss';
import type { ChatLogProps, ChatPendingMessage } from './types';

/**
 * 滚动到底部的辅助函数，使用 requestAnimationFrame 预留节流能力。
 * @param container 当前的滚动容器元素
 */
const scrollNodeToBottom = (container: HTMLDivElement | null) => {
  if (!container) {
    return;
  }
  container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
};

/**
 * 聊天记录滚动组件，负责渲染消息列表并在新消息到来时滚动到底部。
 * @param props ChatLogProps 组件入参
 * @param ref React.Ref 滚动容器引用
 * @returns JSX.Element 聊天记录区块
 */
const ChatLog = forwardRef<HTMLDivElement | null, ChatLogProps>((props, ref) => {
  const {
    messages,
    pendingMessage,
    streamingMessage,
    isLoading = false,
    emptyHint,
    loadingHint,
    onRetry,
    className,
  } = props;

  /** 滚动容器的真实 DOM 引用，用于外部联动控制。 */
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  /** 当前 requestAnimationFrame 的标识，用于节流滚动行为。 */
  const scheduleFrameRef = useRef<number | null>(null);

  useImperativeHandle<HTMLDivElement | null, HTMLDivElement | null>(
    ref,
    () => scrollContainerRef.current,
  );

  /**
   * 调度滚动到底部的操作，避免在同一帧内重复执行。
   */
  const scrollToBottom = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }
    if (scheduleFrameRef.current !== null) {
      window.cancelAnimationFrame(scheduleFrameRef.current);
    }
    scheduleFrameRef.current = window.requestAnimationFrame(() => {
      scrollNodeToBottom(scrollContainerRef.current);
      scheduleFrameRef.current = null;
    });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [
    messages,
    pendingMessage?.id,
    pendingMessage?.content,
    streamingMessage?.id,
    streamingMessage?.content,
    scrollToBottom,
  ]);

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && scheduleFrameRef.current !== null) {
        window.cancelAnimationFrame(scheduleFrameRef.current);
      }
    };
  }, []);

  const resolvedPending = useMemo<ChatPendingMessage | null>(() => {
    if (!pendingMessage) {
      return null;
    }
    const status = pendingMessage.status ?? 'sending';
    return { ...pendingMessage, status };
  }, [pendingMessage]);

  const containerClassName = useMemo(
    () => [styles.chatLog, className].filter(Boolean).join(' '),
    [className],
  );

  const hasMessages =
    messages.length > 0 || Boolean(resolvedPending) || Boolean(streamingMessage);

  return (
    <div className={containerClassName}>
      <div ref={scrollContainerRef} className={styles.scrollContainer}>
        {hasMessages ? (
          <div className={styles.messagesList}>
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} onRetry={onRetry} />
            ))}
            {resolvedPending ? (
              <MessageBubble
                key={resolvedPending.id ?? 'pending'}
                message={resolvedPending}
                onRetry={onRetry}
              />
            ) : null}
            {streamingMessage ? (
              <MessageBubble
                key={streamingMessage.id}
                message={{ ...streamingMessage, status: streamingMessage.status ?? 'sending' }}
                onRetry={onRetry}
              />
            ) : null}
          </div>
        ) : !isLoading ? (
          <div className={styles.placeholder}>{emptyHint ?? '暂未开始任何对话'}</div>
        ) : null}
        {isLoading ? (
          <div className={styles.loadingState}>{loadingHint ?? '正在加载历史记录...'}</div>
        ) : null}
      </div>
    </div>
  );
});

ChatLog.displayName = 'ChatLog';

export default ChatLog;
