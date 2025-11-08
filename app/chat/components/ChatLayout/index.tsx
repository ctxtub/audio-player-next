'use client';

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Toast } from 'antd-mobile';

import { beginChatStream, cancelChatStream, retryChatStream } from '@/app/services/chatFlow';
import { useChatStore } from '@/stores/chatStore';

import HeaderArea from './HeaderArea';
import InputArea from './InputArea';
import MessageArea from './MessageArea';
import styles from './index.module.scss';
import type { ChatLayoutProps } from './types';

/**
 * 推荐提问按钮的配置项定义，包含展示文案与发送内容。 
 */
type HeaderSuggestion = {
  /** 唯一标识，便于渲染列表时追踪。 */
  id: string;
  /** 按钮展示文案。 */
  label: string;
  /** 点击后填充到输入框的内容。 */
  value: string;
};

/**
 * 默认推荐提问列表，提供多题材故事引导。 
 */
const defaultSuggestions: HeaderSuggestion[] = [
  { id: 'story-space', label: '星际冒险', value: '请讲一个温柔的星际冒险睡前故事。' },
  { id: 'story-animal', label: '动物好朋友', value: '给我一个关于动物朋友互相帮助的故事。' },
  { id: 'story-mentor', label: '奇幻学徒记', value: '讲一个初入魔法学院的新生如何在导师帮助下成长的故事。' },
  { id: 'story-detective', label: '谜案侦探团', value: '来一段少年侦探与伙伴破解古堡谜案的故事。' },
  { id: 'story-ocean', label: '深海探险家', value: '请讲述一位小潜航员在深海发现神秘文明的故事。' },
  { id: 'story-forest', label: '森林守护队', value: '分享一个森林守护者与精灵联手拯救家园的故事。' },
];

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
  const inputValue = useChatStore((state) => state.inputValue);
  const setInputValue = useChatStore((state) => state.setInputValue);

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
   * 输入框内容变化时同步到 store，便于外部组件访问。 
   * @param next 最新的输入内容。
   */
  const handleInputChange = useCallback(
    (next: string) => {
      setInputValue(next);
    },
    [setInputValue],
  );

  /**
   * 点击推荐提问时快速填充输入框，如在发送中则提醒稍后再试。
   * @param value 推荐文案内容。
   */
  const handleSuggestionSelect = useCallback(
    (value: string) => {
      if (isSending) {
        Toast.show({ icon: 'fail', content: '正在生成回答，请稍后再试' });
        return;
      }
      setInputValue(value);
    },
    [isSending, setInputValue],
  );

  /** 是否展示顶部欢迎区，根据是否存在历史消息决定。 */
  const shouldShowHeader = useMemo(
    () => messages.length === 0 && !pendingMessage && !activeAssistantMessage,
    [messages.length, pendingMessage, activeAssistantMessage],
  );

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
      <HeaderArea
        visible={shouldShowHeader}
        suggestions={defaultSuggestions}
        onSuggestionSelect={handleSuggestionSelect}
      />
      <MessageArea
        messages={resolvedMessages}
        pendingMessage={pendingMessage}
        streamingMessage={activeAssistantMessage}
        isLoading={false}
        onRetry={handleRetry}
      />
      <InputArea
        onSubmit={handleSubmit}
        disabled={isSending}
        isSending={isSending}
        value={inputValue}
        onChange={handleInputChange}
      />
    </div>
  );
};

export default ChatLayout;
