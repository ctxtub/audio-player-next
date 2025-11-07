import React from 'react';
import InputArea from './InputArea';
import MessageArea from './MessageArea';
import TopBar from './TopBar';
import styles from './index.module.scss';

/**
 * 聊天页面布局组件，组织顶部栏、消息区与输入区。
 * @param props.userNickname 当前用户昵称。
 * @param props.conversationId 当前会话 ID，可为空。
 * @returns 布局结构 JSX。
 */
const ChatLayout: React.FC<{ userNickname: string; conversationId: string | null }> = ({
  userNickname,
  conversationId,
}) => {
  return (
    <div className={styles.chatLayout}>
      <TopBar
        conversationId={conversationId}
        userNickname={userNickname}
      />
      <MessageArea />
      <InputArea />
    </div>
  );
};

export default ChatLayout;
