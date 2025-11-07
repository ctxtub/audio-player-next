import React from 'react';
import ChatLayout from './components/ChatLayout';

/**
 * 聊天页面壳组件，负责准备服务端数据并渲染布局。
 * @returns 聊天页面 JSX。
 */
const ChatPage = async () => {
  const userNickname = '未登录用户';
  const conversationId: string | null = null;

  return (
    <ChatLayout
      conversationId={conversationId}
      userNickname={userNickname}
    />
  );
};

export default ChatPage;
