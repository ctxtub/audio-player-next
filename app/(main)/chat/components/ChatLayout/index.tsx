'use client';

import React, { useCallback, useEffect, useMemo } from 'react';
import GlassToast from '@/components/ui/GlassToast';

import { beginChatStream, retryChatStream } from '@/app/services/chatFlow';
import { preemptContinuousCreationForUserInput } from '@/app/services/continuousCreationFlow';
import { startNewCreation } from '@/app/services/startNewCreation';
import { getCollection } from '@/lib/client/collection';
import { useChatStore } from '@/stores/chatStore';
import { usePlaybackStore } from '@/stores/playbackStore';

import HeaderArea from './HeaderArea';
import OnboardingModal from '../OnboardingModal';
import InputArea from './InputArea';
import MessageArea from './MessageArea';
import ContinuousCreationBar from '../ContinuousCreationBar';
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
 * 聊天页面布局组件，组织连续创作状态卡、消息区与输入区。
 *
 * History Surface 已退役；「清空」升级为唯一「新建创作」强重置入口。
 * @returns 布局结构 JSX。
 */
const ChatLayout: React.FC<ChatLayoutProps> = () => {
  const messages = useChatStore((state) => state.messages);
  const inputValue = useChatStore((state) => state.inputValue);
  const setInputValue = useChatStore((state) => state.setInputValue);
  /** 单槽位待发送提示词（推荐提问在生成中排队用；  起不再服务 History）。 */
  const pendingAutoSend = useChatStore((state) => state.pendingAutoSend);
  /** 当前 active Conversation 对应的集合标题（创作页围绕当前集合运行）。 */
  const collectionTitle = useChatStore((state) => state.collectionTitle);
  /** 当前 active Conversation 对应的集合 id。 */
  const collectionId = useChatStore((state) => state.collectionId);
  /** 是否存在发送中的消息，用于控制输入区禁用状态 */
  const isSending = useMemo(
    () => messages.some((m) => m.status === 'sending'),
    [messages],
  );

  // 有集合但标题未知时补拉集合标题（创作页围绕当前集合运行）。
  useEffect(() => {
    if (!collectionId || collectionTitle) {
      return;
    }
    let cancelled = false;
    getCollection(collectionId)
      .then((collection) => {
        if (cancelled) {
          return;
        }
        useChatStore.getState().applyConversationIdentity({
          conversationId: useChatStore.getState().conversationId,
          collectionId,
          collectionTitle: collection.title,
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [collectionId, collectionTitle]);

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
      // 用户主动输入即抢占连续创作：丢弃在途/就绪的下一作品并作废旧回调。
      preemptContinuousCreationForUserInput();
      await usePlaybackStore.getState().ensureUnlocked();
      await beginChatStream(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : '发送失败，请稍后重试';
      GlassToast.show({ icon: 'fail', content: message });
    }
  }, []);

  // 推荐提问同页自动发送：只写 pendingAutoSend，本 effect 为唯一消费路径。
  // 02-02 UX：发送中到达的 pending 不丢（保留待发），生成结束（isSending 翻转）重触发消费补发。
  useEffect(() => {
    if (!pendingAutoSend) {
      return;
    }

    if (isSending) {
      return;
    }

    const prompt = pendingAutoSend;
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
      //   评审闭合：重试前抢占在途/就绪的下一作品，避免 abort 后旧预载
      // 的失败被误记为连续创作 error，且旧结果不得复活。
      preemptContinuousCreationForUserInput();
      await retryChatStream();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '重试失败，请稍后再试';
      GlassToast.show({ icon: 'fail', content: message });
    }
  }, []);

  /**
   * 唯一「新建创作」入口：强重置当前集合运行态。
   * 仅当存在草稿/在途内容时确认；确认后由 startNewCreation 承担全部副作用。
   */
  const handleNewCreation = useCallback(() => {
    const needsConfirm = useChatStore.getState().messages.length > 0;
    void startNewCreation({
      confirm: () => {
        if (!needsConfirm) {
          return true;
        }
        if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
          return true;
        }
        return window.confirm('开始新建创作？当前会话内容将被清空。');
      },
    });
  }, []);

  return (
    <div className={styles.chatLayout}>
      <OnboardingModal />

      <HeaderArea
        visible={shouldShowHeader}
        suggestions={defaultSuggestions}
        onSuggestionSelect={handleSuggestionSelect}
      />
      <ContinuousCreationBar collectionTitle={collectionTitle} />
      <MessageArea
        messages={messages}
        isLoading={false}
        onRetry={handleRetry}
      />
      <InputArea
        onSubmit={handleSubmit}
        disabled={isSending}
        isSending={isSending}
        value={inputValue}
        onChange={handleInputChange}
        onClear={handleNewCreation}
        clearText="新建创作"
      />
    </div>
  );
};

export default ChatLayout;
