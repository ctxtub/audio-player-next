'use client';

import { Avatar } from 'antd-mobile';
import { useMemo, type FC } from 'react';

import type {
  ChatMessage,
  ChatMessageDeliveryStatus,
  ChatMessageRole,
  ChatPendingMessage,
} from '@/types/chat';
import styles from './MessageBubble.module.scss';

/**
 * 消息气泡组件的入参定义，包含消息内容与重试回调。
 */
type MessageBubbleProps = {
  /** 需要展示的消息内容，支持历史消息与待发送消息。 */
  message: ChatMessage | ChatPendingMessage;
  /** 失败时的重试回调。 */
  onRetry?: (messageId?: string) => void;
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
const fallbackPersonaMap: Record<ChatMessageRole, { name: string; avatar: string; fallback: string }> = {
  assistant: { name: '故事助手', avatar: '/icons/avatar-assistant.svg', fallback: '助' },
  user: { name: '我', avatar: '/icons/avatar-user.svg', fallback: '我' },
  system: { name: '系统提示', avatar: '/icons/avatar-assistant.svg', fallback: '系' },
  developer: { name: '系统提示', avatar: '/icons/avatar-assistant.svg', fallback: '系' },
  function: { name: '函数输出', avatar: '/icons/avatar-assistant.svg', fallback: '函' },
  tool: { name: '工具消息', avatar: '/icons/avatar-assistant.svg', fallback: '工' },
};

/**
 * 判断角色是否需要隐藏头像展示。 
 * @param role 当前消息角色。
 */
const shouldHideAvatar = (role: ChatMessageRole) =>
  role === 'system' || role === 'developer' || role === 'function' || role === 'tool';

/**
 * 单条聊天消息的气泡组件，负责处理角色样式与发送状态提示。
 * @param props.message 聊天消息实体
 * @param props.onRetry 失败重试回调
 * @returns JSX.Element 消息气泡
 */
const MessageBubble: FC<MessageBubbleProps> = ({ message, onRetry }) => {
  const status = (message.status ?? 'delivered') as ChatMessageDeliveryStatus;
  const isSending = status === 'sending';
  const isFailed = status === 'failed';
  const roleKey: ChatMessageRole = message.role;

  const rowClassName = [styles.row, roleRowClassMap[roleKey]].filter(Boolean).join(' ');
  const bubbleClassName = [
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

  const persona = fallbackPersonaMap[roleKey];
  const displayName = message.displayName ?? persona.name;
  const avatarSrc = message.avatar ?? persona.avatar;
  const avatarFallback = persona.fallback;

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
        <Avatar
          className={styles.avatar}
          src={avatarSrc}
          fallback={avatarFallback}
          aria-label={`${displayName}头像`}
        />
      )}
      <div className={styles.bubbleWrapper}>
        <div className={styles.headerRow}>
          <span className={styles.displayName}>{displayName}</span>
          {formattedTime ? <time className={styles.timestamp}>{formattedTime}</time> : null}
        </div>
        <div className={bubbleClassName}>{message.content}</div>
        {(isSending || isFailed) && (
          <div className={styles.metaRow}>
            <span className={statusClassName}>{isSending ? '发送中...' : '发送失败'}</span>
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
