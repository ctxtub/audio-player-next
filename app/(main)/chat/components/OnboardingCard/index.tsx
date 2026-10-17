'use client';

import React from 'react';
import Image from 'next/image';
import { avatarAssistant } from '@/lib/assets/avatars';
import GlassButton from '@/components/ui/GlassButton';
import styles from './index.module.scss';

export interface OnboardingCardProps {
  suggestions: Array<{ id: string; label: string; value: string }>;
  onSuggestionSelect: (value: string) => void;
  onDismiss?: () => void;
  compact?: boolean;
}

/**
 * 创作页首次 Agent 欢迎气泡：
 * 以自然对话气泡融入时间线，消除独立居中模块割裂感；
 * 明确区分只读使用说明与可点击灵感胶囊，正式创作时隐藏。
 */
const OnboardingCard: React.FC<OnboardingCardProps> = ({
  suggestions,
  onSuggestionSelect,
  onDismiss,
  compact = false,
}) => {
  return (
    <div className={styles.row} role="region" aria-label="创作引导">
      <Image
        className={styles.avatar}
        src={avatarAssistant}
        alt="故事伙伴头像"
        width={36}
        height={36}
        unoptimized
      />
      <div className={styles.bubbleWrapper}>
        <div className={styles.headerRow}>
          <span className={styles.displayName}>故事伙伴</span>
          <span className={styles.badge}>故事工坊</span>
        </div>

        <div className={styles.bubble}>
          <p className={styles.greeting}>
            {compact ? '想听什么故事？选一个主题，或在下方写下你的想法。' : '你好呀！我是你的故事伙伴。告诉我你感兴趣的主题，我来为你编织并朗读专属故事。'}
          </p>

          {!compact && <div className={styles.guideBlock}>
            <span className={styles.guideTitle}>创作指引</span>
            <ol className={styles.guideList}>
              <li><strong>挑选主题</strong>：点选下方推荐主题，或在底部直接写下构想</li>
              <li><strong>互动创作</strong>：向我提出角色与情节要求，故事逐步展开</li>
              <li><strong>静心伴听</strong>：就绪后自动朗读播放，伴你宁静入眠</li>
            </ol>
          </div>}

          {suggestions.length > 0 ? (
            <div className={styles.suggestionsBlock}>
              <span className={styles.suggestionsTitle}>推荐主题</span>
              <div className={styles.suggestionGrid}>
                {suggestions.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSuggestionSelect(item.value)}
                    className={styles.suggestionButton}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {onDismiss ? (
            <div className={styles.footerRow}>
              <GlassButton
                variant="primary"
                size="sm"
                onPress={onDismiss}
                className={styles.startButton}
              >
                开始体验
              </GlassButton>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default OnboardingCard;
