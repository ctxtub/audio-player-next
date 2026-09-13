'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import GlassToast from '@/components/ui/GlassToast';

import { beginChatStream, retryChatStream } from '@/app/services/chatFlow';
import { resetStoryFlow } from '@/app/services/storyFlow';
import { useChatStore } from '@/stores/chatStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useFloatingPlayer } from '@/components/FloatingPlayer';

import HeaderArea from './HeaderArea';
import OnboardingModal from '../OnboardingModal';
import InputArea from './InputArea';
import MessageArea from './MessageArea';
import HistoryPanel from '../HistoryPanel';
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
 * 聊天页面布局组件，组织消息区与输入区，并持有 Chat-owned History Surface 纯 UI 开关。
 * @param props.initialMessages 初始消息列表。
 * @returns 布局结构 JSX。
 */
const ChatLayout: React.FC<ChatLayoutProps> = () => {


  const messages = useChatStore((state) => state.messages);
  const inputValue = useChatStore((state) => state.inputValue);
  const setInputValue = useChatStore((state) => state.setInputValue);
  /** 同页 History 选择的唯一 pending 消费订阅（M4-07：显式订阅，当前已在 /chat，无需 router 再挂载）。 */
  const pendingAutoSend = useChatStore((state) => state.pendingAutoSend);
  /** History Surface 纯 UI 开关（M4-07）：不进 Zustand，不触数据。 */
  const [historyOpen, setHistoryOpen] = useState(false);

  /** 悬浮播放器控制。 */
  const { play: playAudio } = useFloatingPlayer();

  /** 是否存在发送中的消息，用于控制输入区禁用状态 */
  const isSending = useMemo(
    () => messages.some((m) => m.status === 'sending'),
    [messages],
  );

  /** 将 store 与初始消息融合，避免首屏出现空白。 */
  // const resolvedMessages = useMemo(() => {
  //   if (!hasHydrated && messages.length === 0) {
  //     return initialMessages;
  //   }
  //   return messages;
  // }, [initialMessages, messages, hasHydrated]);



  useEffect(() => {
    // 当存在未读响应时，立即标记为已读（已阅）
    // 监听 hasUnviewedResponse 变化，确保生成结束后能及时清除
    const hasUnviewed = useChatStore.getState().hasUnviewedResponse;
    if (hasUnviewed) {
      useChatStore.getState().markResponseAsViewed();
    }

    // 订阅后续变化
    const unsubscribe = useChatStore.subscribe((state) => {
      if (state.hasUnviewedResponse) {
        useChatStore.getState().markResponseAsViewed();
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);



  /**
   * 输入区提交回调，根据意图选择普通聊天流或故事生成流。
   * @param content 用户输入的文本内容。
   */
  const handleSubmit = useCallback(async (content: string) => {
    try {
      await usePlaybackStore.getState().ensureUnlocked();
      await beginChatStream(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : '发送失败，请稍后重试';
      GlassToast.show({ icon: 'fail', content: message });
    }
  }, []);

  // Chat-owned History 同页自动发送：History 选择只写 pendingAutoSend，本 effect 为唯一消费路径。
  // 02-02 UX：发送中到达的 pending 不丢（保留待发），生成结束（isSending 翻转）重触发消费补发。
  useEffect(() => {
    if (!pendingAutoSend) {
      return;
    }

    if (isSending) {
      return;
    }

    const prompt = pendingAutoSend;

    // 中文注释：H-21方案A——从提示词历史开始新创作为干净会话，发送前先重置故事链路（清空旧会话/播放/预载/生成态），再消费 pending 自动发送；此时 messages 已空，新请求不含旧上下文。发送中到达的 pending 仍由上文守卫保留待发，语义不变。
    resetStoryFlow();
    useChatStore.getState().setPendingAutoSend(null);

    setInputValue(prompt);
    void handleSubmit(prompt);
  }, [
    pendingAutoSend,
    isSending,
    handleSubmit,
    setInputValue,
  ]);

  /**
   * History 提示词「重新创作」适配器（M4-07）：只写 pending + 关面板，不直接提交/重置/导航。
   * 消费由上文唯一 pending consumer 承担 exactly-once；发送中选择沿单 slot 覆盖语义排队，不抢当前 attempt。
   * @param prompt 选择的历史提示词。
   */
  const handleHistorySelectPrompt = useCallback((prompt: string) => {
    useChatStore.getState().setPendingAutoSend(prompt);
    setHistoryOpen(false);
  }, []);

  /** 打开 Chat-owned History Surface（纯 UI，不触数据）。 */
  const handleOpenHistory = useCallback(() => {
    setHistoryOpen(true);
  }, []);

  /** 关闭 Chat-owned History Surface（纯 UI，不触数据）。 */
  const handleCloseHistory = useCallback(() => {
    setHistoryOpen(false);
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
   * 点击推荐提问时快速填充输入框，发送中时预填并排队待生成结束自动发送。
   * @param value 推荐文案内容。
   */
  const handleSuggestionSelect = useCallback(
    (value: string) => {
      if (isSending) {
        // 中文注释：02-02 UX——发送中点击仍预填输入框即时可见，并暂存 pending 待生成结束补发。
        setInputValue(value);
        useChatStore.getState().setPendingAutoSend(value);
        GlassToast.show({ icon: 'fail', content: '正在生成，完成后自动发送' });
        return;
      }
      setInputValue(value);
    },
    [isSending, setInputValue],
  );

  /** 是否展示顶部欢迎区，根据是否存在历史消息决定。 */
  const shouldShowHeader = useMemo(
    () => messages.length === 0,
    [messages.length],
  );

  /**
   * 处理失败消息的重试逻辑，确保仅在待重试的消息上触发。
   * @param retryId 触发重试的消息 id。
   */
  const handleRetry = useCallback(async (retryId?: string) => {
    // 检查最后一条失败消息是否匹配
    const lastFailed = useChatStore.getState().selectors.latestFailedMessage();

    if (!lastFailed || lastFailed.id !== retryId) {
      return;
    }
    try {
      await retryChatStream();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '重试失败，请稍后再试';
      GlassToast.show({ icon: 'fail', content: message });
    }
  }, []);

  /**
   * 清空输入框并重置整个故事流（包含聊天记录与音频状态）。
   */
  const handleClear = useCallback(() => {
    resetStoryFlow();
  }, []);

  return (
    <div className={styles.chatLayout}>
      <OnboardingModal />

      <HeaderArea
        visible={shouldShowHeader}
        suggestions={defaultSuggestions}
        onSuggestionSelect={handleSuggestionSelect}
      />
      <MessageArea
        messages={messages}
        isLoading={false}
        onRetry={handleRetry}
        onPlayStory={(url, id) => playAudio(url, id)}
      />
      <InputArea
        onSubmit={handleSubmit}
        disabled={isSending}
        isSending={isSending}
        value={inputValue}
        onChange={handleInputChange}
        onClear={handleClear}
        leftSlot={(
          <button
            type="button"
            className={styles.historyTrigger}
            onClick={handleOpenHistory}
            aria-label="打开历史"
            aria-expanded={historyOpen}
          >
            历史
          </button>
        )}
      />
      {historyOpen ? (
        <div className={styles.historyOverlay} role="dialog" aria-modal="false" aria-label="历史">
          <div className={styles.historyDialog}>
            <HistoryPanel onSelectPrompt={handleHistorySelectPrompt} onClose={handleCloseHistory} />
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default ChatLayout;
