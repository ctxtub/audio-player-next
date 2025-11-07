import React from 'react';
import styles from './index.module.scss';

/**
 * 聊天消息区域，占位展示会话内容列表。
 * @returns 消息区域结构 JSX。
 */
const MessageArea: React.FC = () => {
  return (
    <div className={styles.messageArea}>
      <div>这里将展示消息列表。</div>
    </div>
  );
};

export default MessageArea;
