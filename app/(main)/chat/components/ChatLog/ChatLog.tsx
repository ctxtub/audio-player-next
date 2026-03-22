'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { MessageCircle } from 'lucide-react';
import MessageBubble from './MessageBubble';
import styles from './ChatLog.module.scss';
import type { ChatLogProps } from './types';

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
    isLoading = false,
    emptyHint,
    loadingHint,
    onRetry,
    onPlayStory,
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
    messages, // 只要消息列表长度或内容变化就滚动
    // 如果消息内部属性变化（如流式生成内容更新），可能也需要滚动，messages 引用变化会触发
    scrollToBottom,
  ]);

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && scheduleFrameRef.current !== null) {
        window.cancelAnimationFrame(scheduleFrameRef.current);
      }
    };
  }, []);

  const containerClassName = useMemo(
    () => [styles.chatLog, className].filter(Boolean).join(' '),
    [className],
  );

  const hasMessages = messages.length > 0;

  /** 滚动容器类名，根据空状态追加去除底部内边距的样式。 */
  const scrollContainerClassName = useMemo(
    () =>
      [
        styles.scrollContainer,
        !hasMessages && !isLoading ? styles.scrollContainerEmpty : null,
      ]
        .filter(Boolean)
        .join(' '),
    [hasMessages, isLoading],
  );

  return (
    <div className={containerClassName}>
      <div ref={scrollContainerRef} className={scrollContainerClassName}>
        {hasMessages ? (
          <div className={styles.messagesList}>
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                onRetry={onRetry}
                onPlayStory={onPlayStory}
              />
            ))}
          </div>
        ) : !isLoading ? (
          <div className={styles.placeholder}>
            <div className={styles.emptyContent}>
              <div className={styles.emptyIcon}>
                <MessageCircle size={60} strokeWidth={1.2} />
              </div>
              <p className={styles.emptyText}>{emptyHint ?? '暂未开始任何对话'}</p>
            </div>
          </div>
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
