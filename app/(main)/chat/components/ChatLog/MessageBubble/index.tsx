'use client';

import { useMemo, type FC } from 'react';
import Image, { type StaticImageData } from 'next/image';

import type {
  ChatMessage,
  ChatMessageDeliveryStatus,
  ChatMessageRole,
  ChatPendingMessage,
} from '@/types/chat';
import {
  avatarAssistant,
  avatarUser,
  avatarStoryAgent,
  avatarChatAgent,
  avatarGuidanceAgent,
  avatarSummaryAgent,
} from '@/lib/assets/avatars';
import MessagePartRenderer from '../../MessageParts';
import styles from './MessageBubble.module.scss';

/**
 * 消息气泡组件的入参定义，包含消息内容与回调。
 */
type MessageBubbleProps = {
  /** 需要展示的消息内容，支持历史消息与待发送消息。 */
  message: ChatMessage | ChatPendingMessage;
  /** 失败时的重试回调。 */
  onRetry?: (messageId?: string) => void;
  /** 播放故事的回调，由 StoryCardPart 触发。 */
  onPlayStory?: (audioUrl: string, messageId: string) => void;
};

/**
 * 不同角色对应的容器布局 class 映射表。
 */
const roleRowClassMap: Record<ChatMessageRole, string> = {
  assistant: styles.rowAssistant,
  user: styles.rowUser,
  system: styles.rowSystem,
  developer: styles.rowSystem,
  function: styles.rowSystem,
  tool: styles.rowSystem,
};

/**
 * 不同角色对应的气泡样式 class 映射表。
 */
const roleBubbleClassMap: Record<ChatMessageRole, string> = {
  assistant: styles.bubbleAssistant,
  user: styles.bubbleUser,
  system: styles.bubbleSystem,
  developer: styles.bubbleSystem,
  function: styles.bubbleSystem,
  tool: styles.bubbleSystem,
};

/**
 * 角色对应的默认展示信息，避免缺失头像或昵称。 
 */
const fallbackPersonaMap: Record<ChatMessageRole, { name: string; avatar: StaticImageData }> = {
  assistant: { name: 'Agent助手', avatar: avatarAssistant },
  user: { name: '我', avatar: avatarUser },
  system: { name: '系统提示', avatar: avatarAssistant },
  developer: { name: '系统提示', avatar: avatarAssistant },
  function: { name: '函数输出', avatar: avatarAssistant },
  tool: { name: '工具消息', avatar: avatarAssistant },
};

/**
 * 判断角色是否需要隐藏头像展示。 
 * @param role 当前消息角色。
 */
const shouldHideAvatar = (role: ChatMessageRole) =>
  role === 'system' || role === 'developer' || role === 'function' || role === 'tool';


/**
 * Agent 身份配置表
 */
const agentPersonaMap: Record<string, { name: string; avatar: StaticImageData }> = {
  'story_agent': { name: '创作Agent', avatar: avatarStoryAgent },
  'chat_agent': { name: '聊天Agent', avatar: avatarChatAgent },
  'guidance_agent': { name: '指令Agent', avatar: avatarGuidanceAgent },
  'summary_agent': { name: '摘要Agent', avatar: avatarSummaryAgent },
};

/**
 * 单条聊天消息的气泡组件，负责处理角色样式与发送状态提示。
 * @param props.message 聊天消息实体
 * @param props.onRetry 失败重试回调
 * @param props.onPlayStory 播放故事回调
 * @returns JSX.Element 消息气泡
 */
const MessageBubble: FC<MessageBubbleProps> = ({ message, onRetry, onPlayStory }) => {
  const status = (message.status ?? 'delivered') as ChatMessageDeliveryStatus;
  const isSending = status === 'sending';
  const isFailed = status === 'failed';
  const roleKey: ChatMessageRole = message.role;
  const agentType = 'metadata' in message ? message.metadata?.agentType : undefined;

  /** 消息片段，优先使用 parts，回退到 content。 */
  const messageParts = useMemo(() => {
    const parts = message.parts;

    if (!parts || parts.length === 0) {
      return [{ type: 'text' as const, content: message.content }];
    }

    return parts;
  }, [message]);

  /** 发送中助手消息的占位内容，避免空白气泡。 */
  const isEmptyAssistant = useMemo(() => {
    if (roleKey === 'assistant' && isSending) {
      // 检查是否有实质内容
      const hasContent = messageParts.some((part) => {
        if ('content' in part && typeof part.content === 'string') return part.content.trim().length > 0;
        if ('storyText' in part) return part.storyText.trim().length > 0;
        return false;
      });
      return !hasContent;
    }
    return false;
  }, [isSending, messageParts, roleKey]);

  /** 是否为卡片类视图（Story/Guidance/Summary），此类视图不展示气泡背景 */
  const isCardView = useMemo(() => {
    return messageParts.some((part) =>
      ['storyCard', 'guidance', 'summary'].includes(part.type)
    );
  }, [messageParts]);

  const rowClassName = [styles.row, roleRowClassMap[roleKey]].filter(Boolean).join(' ');

  // 如果是卡片视图且不是显示“思考中...”占位符时，移除以 bubble 样式
  const shouldRemoveBubble = isCardView && !isEmptyAssistant;

  const bubbleClassName = shouldRemoveBubble
    ? ''
    : [
      styles.bubble,
      roleBubbleClassMap[roleKey],
      isSending ? styles.bubbleSending : '',
      isFailed ? styles.bubbleFailed : '',
    ]
      .filter(Boolean)
      .join(' ');
  const statusClassName = [
    styles.status,
    isSending ? styles.statusSending : '',
    isFailed ? styles.statusFailed : '',
  ]
    .filter(Boolean)
    .join(' ');

  const defaultPersona = fallbackPersonaMap[roleKey];
  const currentPersona = (agentType ? agentPersonaMap[agentType] : undefined) ?? defaultPersona;

  const displayName = currentPersona.name;
  const avatarSrc = currentPersona.avatar;

  const formattedTime = useMemo(() => {
    if (!message.createdAt) {
      return '';
    }
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(message.createdAt));
    } catch {
      return '';
    }
  }, [message.createdAt]);

  return (
    <div className={rowClassName}>
      {shouldHideAvatar(roleKey) ? null : (
        <Image
          className={styles.avatar}
          src={avatarSrc}
          alt={`${displayName}头像`}
          unoptimized
        />
      )}
      <div className={styles.bubbleWrapper}>
        <div className={styles.headerRow}>
          <span className={styles.displayName}>{displayName}</span>
          {formattedTime ? <time className={styles.timestamp}>{formattedTime}</time> : null}
        </div>
        <div className={bubbleClassName}>
          {isEmptyAssistant ? (
            <div className={styles.loadingContainer}>
              <span className={styles.shimmerText}>正在为您构思</span>
              <div className={styles.dotFlashing}></div>
            </div>
          ) : (
            messageParts.map((part, index) => (
              <MessagePartRenderer
                key={index}
                part={part}
                // 确保将当前消息 ID 传递出去，用于播放时的 ID 追踪
                onPlayStory={(url) => onPlayStory?.(url, message.id || '')}
              />
            ))
          )}
        </div>
        {isFailed && (
          <div className={styles.metaRow}>
            <span className={statusClassName}>发送失败</span>
            {isFailed && onRetry ? (
              <button
                type="button"
                className={styles.retryButton}
                onClick={() => onRetry(message.id)}
              >
                重试
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
};

export default MessageBubble;
