import React from 'react';
import ChatPage from './index';

/**
 * 聊天页面路由入口，转发至 ChatPage 组件。
 * @returns 聊天页面路由节点。
 */
const Page: React.FC = () => {
  return <ChatPage />;
};

export default Page;
