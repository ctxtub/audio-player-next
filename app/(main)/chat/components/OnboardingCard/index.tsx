'use client';

import React from 'react';
import { BookOpen, Headphones, Palette, Sparkles, type LucideIcon } from 'lucide-react';
import GlassButton from '@/components/ui/GlassButton';
import styles from './index.module.scss';

export interface OnboardingCardProps {
  suggestions: Array<{ id: string; label: string; value: string }>;
  onSuggestionSelect: (value: string) => void;
  onDismiss?: () => void;
}

const ONBOARDING_STEPS = [
  {
    icon: Palette as LucideIcon,
    name: '选一个主题',
    desc: '从推荐灵感开始，也可以自定义故事想法',
  },
  {
    icon: BookOpen as LucideIcon,
    name: '一起创作',
    desc: '表达你的构想，故事会在这里逐步展开',
  },
  {
    icon: Headphones as LucideIcon,
    name: '伴听收听',
    desc: '语音生成就绪后，按下播放静心伴听',
  },
];

/**
 * 创作页新手引导卡片：将原本置顶横幅与弹窗融合为卡片，正式创作时隐藏。
 */
const OnboardingCard: React.FC<OnboardingCardProps> = ({
  suggestions,
  onSuggestionSelect,
  onDismiss,
}) => {
  return (
    <div className={styles.card} role="region" aria-label="创作引导">
      <div className={styles.headerRow}>
        <div className={styles.iconBadge} aria-hidden>
          <Sparkles size={22} strokeWidth={2} />
        </div>
        <div className={styles.headerText}>
          <h2 className={styles.title}>欢迎来到故事工坊</h2>
          <p className={styles.subtitle}>选一个主题开启创作，或在下方输入框直接写下你的奇思妙想。</p>
        </div>
      </div>

      <div className={styles.stepsGrid}>
        {ONBOARDING_STEPS.map((step) => {
          const Icon = step.icon;
          return (
            <div key={step.name} className={styles.stepItem}>
              <Icon size={18} strokeWidth={1.8} className={styles.stepIcon} />
              <div className={styles.stepBody}>
                <span className={styles.stepName}>{step.name}</span>
                <span className={styles.stepDesc}>{step.desc}</span>
              </div>
            </div>
          );
        })}
      </div>

      {suggestions.length > 0 ? (
        <div className={styles.suggestionsSection}>
          <span className={styles.suggestionsLabel}>✨ 灵感推荐</span>
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
            className={styles.dismissButton}
          >
            开始体验
          </GlassButton>
        </div>
      ) : null}
    </div>
  );
};

export default OnboardingCard;
