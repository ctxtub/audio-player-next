'use client';

import React from 'react';
import GlassButton from '@/components/ui/GlassButton';
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
 */
const HeaderArea: React.FC<HeaderAreaProps> = ({ visible, suggestions, onSuggestionSelect }) => {
  if (!visible) {
    return null;
  }

  return (
    <div className={styles.headerArea}>
      <div className={styles.heroRow}>
        <img
          className={styles.avatar}
          src="/icons/avatar-assistant.jpeg"
          alt="Agent助手头像"
        />
        <div className={styles.textBlock}>
          <h2 className={styles.title}>你好，我是Agent助手</h2>
          <p className={styles.subtitle}>告诉我你感兴趣的主题，马上为你定制专属故事剧集。</p>
        </div>
      </div>
      {suggestions.length > 0 ? (
        <div className={styles.suggestionList}>
          {suggestions.map((item) => (
            <GlassButton
              key={item.id}
              variant="outline"
              size="sm"
              onPress={() => onSuggestionSelect(item.value)}
              className={styles.suggestionButton}
            >
              {item.label}
            </GlassButton>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export default HeaderArea;
