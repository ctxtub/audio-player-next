import React from 'react';
import styles from './index.module.scss';
import type { ChatLayoutProps } from './types';

/**
 * 顶部栏组件属性，复用聊天布局元数据字段。
 */
type TopBarProps = Pick<ChatLayoutProps, 'userNickname' | 'conversationId'>;

/**
 * 聊天顶部栏，展示当前用户昵称与会话标识占位。
 * @param props.userNickname 当前用户昵称。
 * @param props.conversationId 当前会话 ID，可为空。
 * @returns 顶部栏结构 JSX。
 */
const TopBar: React.FC<TopBarProps> = ({ userNickname, conversationId }) => {
  return (
    <div className={styles.topBar}>
      <div className={styles.topBarMeta}>
        <div className={styles.topBarMetaRow}>
          <span className={styles.topBarMetaLabel}>当前用户</span>
          <span className={styles.topBarMetaValue}>{userNickname}</span>
        </div>
        <div className={styles.topBarMetaRow}>
          <span className={styles.topBarMetaLabel}>会话标识</span>
          <span className={styles.topBarMetaValue}>{conversationId ?? '待创建'}</span>
        </div>
      </div>
    </div>
  );
};

export default TopBar;
