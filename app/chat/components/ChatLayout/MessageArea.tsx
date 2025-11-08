import React from 'react';
import ChatLog from '../ChatLog/ChatLog';
import styles from './index.module.scss';
import type { ChatLogProps } from '../ChatLog/types';

/**
 * 消息区域组件的属性定义，复用 ChatLog 的主要入参。
 */
type MessageAreaProps = Pick<
  ChatLogProps,
  'messages' | 'pendingMessage' | 'streamingMessage' | 'isLoading' | 'emptyHint' | 'loadingHint' | 'onRetry'
>;

/**
 * 聊天消息区域，占位展示会话内容列表。
 * @returns 消息区域结构 JSX。
 */
const MessageArea: React.FC<MessageAreaProps> = ({
  messages,
  pendingMessage,
  streamingMessage,
  isLoading,
  emptyHint,
  loadingHint,
  onRetry,
}) => {
  return (
    <div className={styles.messageArea}>
      <ChatLog
        className={styles.chatLogContainer}
        messages={messages}
        pendingMessage={pendingMessage}
        streamingMessage={streamingMessage}
        isLoading={isLoading}
        emptyHint={emptyHint}
        loadingHint={loadingHint}
        onRetry={onRetry}
      />
    </div>
  );
};

export default MessageArea;
