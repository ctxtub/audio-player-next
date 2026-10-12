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
        <div className={styles.avatar}>书</div>
        <div className={styles.textBlock}>
          <h2 className={styles.title}>想听什么故事？</h2>
          <p className={styles.subtitle}>选一个主题，开始创作；准备好后，就能在这里收听。</p>
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
