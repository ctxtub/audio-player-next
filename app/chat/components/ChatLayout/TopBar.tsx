import React from 'react';
import styles from './index.module.scss';

/**
 * 聊天顶部栏，展示当前用户昵称与会话标识占位。
 * @param props.userNickname 当前用户昵称。
 * @param props.conversationId 当前会话 ID，可为空。
 * @returns 顶部栏结构 JSX。
 */
const TopBar: React.FC<{ userNickname: string; conversationId: string | null }>
  = ({ userNickname, conversationId }) => {
    return (
      <div className={styles.topBar}>
        <div>{`用户：${userNickname}`}</div>
        <div>{`会话：${conversationId ?? '待创建'}`}</div>
      </div>
    );
  };

export default TopBar;
