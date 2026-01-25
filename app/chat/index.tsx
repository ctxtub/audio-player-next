import React from 'react';
import ChatLayout from './components/ChatLayout';
import styles from './index.module.scss';

/**
 * 聊天页面壳组件，负责准备服务端数据并渲染布局。
 * @returns 聊天页面 JSX。
 */
const ChatPage = async () => {
  return (
    <div className={styles.chatPage}>
      <div className={styles.mainContent}>
        <ChatLayout />
      </div>
    </div>
  );
};

export default ChatPage;
