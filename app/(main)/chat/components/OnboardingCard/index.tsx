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
}) => {
  return (
    <div className={styles.row} role="region" aria-label="创作引导">
      <Image
        className={styles.avatar}
        src={avatarAssistant}
        alt="Agent助手头像"
        width={36}
        height={36}
        unoptimized
      />
      <div className={styles.bubbleWrapper}>
        <div className={styles.headerRow}>
          <span className={styles.displayName}>Agent助手</span>
          <span className={styles.badge}>故事工坊</span>
        </div>

        <div className={styles.bubble}>
          <p className={styles.greeting}>
            你好呀！我是你的故事伙伴。告诉我你感兴趣的主题，我来为你编织并朗读专属故事。
          </p>

          <div className={styles.guideBlock}>
            <span className={styles.guideTitle}>💡 创作指引：</span>
            <ol className={styles.guideList}>
              <li><strong>挑选主题</strong>：点选下方灵感胶囊，或在底部直接写下你的想法</li>
              <li><strong>互动创作</strong>：向我提出角色与情节构想，故事会逐步展开</li>
              <li><strong>静心伴听</strong>：故事生成就绪后随时播放，伴你宁静入眠</li>
            </ol>
          </div>

          {suggestions.length > 0 ? (
            <div className={styles.suggestionsBlock}>
              <span className={styles.suggestionsTitle}>✨ 点击直接开启故事：</span>
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
