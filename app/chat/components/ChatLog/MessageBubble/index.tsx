import type { FC } from 'react';
import type {
  ChatMessage,
  ChatMessageDeliveryStatus,
  ChatMessageRole,
  ChatPendingMessage,
} from '../types';
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
};

/**
 * 不同角色对应的气泡样式 class 映射表。
 */
const roleBubbleClassMap: Record<ChatMessageRole, string> = {
  assistant: styles.bubbleAssistant,
  user: styles.bubbleUser,
  system: styles.bubbleSystem,
};

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

  return (
    <div className={rowClassName}>
      <div className={styles.bubbleWrapper}>
        <div className={bubbleClassName}>
          {message.content}
        </div>
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
