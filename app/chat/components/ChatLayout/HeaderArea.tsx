'use client';

import React from 'react';
import { Avatar, Button } from 'antd-mobile';

import styles from './HeaderArea.module.scss';

/**
 * 顶部欢迎区组件的入参定义。
 */
type HeaderAreaProps = {
  /** 是否展示欢迎区，false 时直接返回 null。 */
  visible: boolean;
  /** 推荐提问按钮列表。 */
  suggestions: Array<{ id: string; label: string; value: string }>;
  /** 点击推荐项时触发的回调。 */
  onSuggestionSelect: (value: string) => void;
};

/**
 * 聊天顶部欢迎与推荐区，包含头像、欢迎语与快捷问题。
 * @param props.visible 控制显隐。
 * @param props.suggestions 推荐按钮列表。
 * @param props.onSuggestionSelect 点击推荐项时的回调。
 * @returns 顶部欢迎区 JSX。
 */
const HeaderArea: React.FC<HeaderAreaProps> = ({ visible, suggestions, onSuggestionSelect }) => {
  if (!visible) {
    return null;
  }

  return (
    <div className={styles.headerArea}>
      <div className={styles.heroRow}>
        <Avatar
          className={styles.avatar}
          src="/icons/avatar-assistant.svg"
          fallback="助"
          aria-label="Agent助手头像"
        />
        <div className={styles.textBlock}>
          <h2 className={styles.title}>你好，我是Agent助手</h2>
          <p className={styles.subtitle}>告诉我你感兴趣的主题，马上为你定制专属故事剧集。</p>
        </div>
      </div>
      {suggestions.length > 0 ? (
        <div className={styles.suggestionList}>
          {suggestions.map((item) => (
            <Button
              key={item.id}
              size="small"
              color="primary"
              fill="outline"
              shape="rounded"
              className={styles.suggestionButton}
              onClick={() => onSuggestionSelect(item.value)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export default HeaderArea;
