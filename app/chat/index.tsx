import React from 'react';
import ChatLayout from './components/ChatLayout';
import styles from './index.module.scss';
import type { ChatMessage } from '@/types/chat';

/**
 * 聊天页面壳组件，负责准备服务端数据并渲染布局。
 * @returns 聊天页面 JSX。
 */
const ChatPage = async () => {
  /** 默认展示的示例消息列表，模拟已有对话上下文。 */
  const initialMessages: ChatMessage[] = [
    {
      id: 'system-welcome',
      role: 'system',
      content: '欢迎来到故事工坊，随时告诉我想听的主题吧！',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'assistant-hello',
      role: 'assistant',
      content: '你好呀！要不要来点奇幻冒险或者温馨治愈的故事？',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'user-preference',
      role: 'user',
      content: '我想听一段关于太空旅行的睡前故事。',
      createdAt: new Date().toISOString(),
    },
  ];

  return (
    <div className={styles.chatPage}>
      <div className={styles.mainContent}>
        <ChatLayout initialMessages={initialMessages} />
      </div>
    </div>
  );
};

export default ChatPage;
