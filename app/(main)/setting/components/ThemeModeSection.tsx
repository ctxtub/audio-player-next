'use client';

import React, { useCallback } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import type { ThemeMode } from '@/types/theme';
import GlassSelector from '@/components/ui/GlassSelector';
import styles from '../index.module.scss';

/**
 * 可供选择的主题模式列表。
 */
const THEME_OPTIONS = [
  { value: 'light' as ThemeMode, label: <div className={styles.themeOption}><span className={styles.themeOptionIcon} aria-hidden><Sun size={18} strokeWidth={1.8} /></span><div className={styles.themeOptionContent}><span className={styles.themeOptionLabel}>亮色模式</span></div></div> },
  { value: 'dark' as ThemeMode, label: <div className={styles.themeOption}><span className={styles.themeOptionIcon} aria-hidden><Moon size={18} strokeWidth={1.8} /></span><div className={styles.themeOptionContent}><span className={styles.themeOptionLabel}>暗色模式</span></div></div> },
  { value: 'system' as ThemeMode, label: <div className={styles.themeOption}><span className={styles.themeOptionIcon} aria-hidden><Monitor size={18} strokeWidth={1.8} /></span><div className={styles.themeOptionContent}><span className={styles.themeOptionLabel}>跟随系统</span></div></div> },
];

/**
 * 主题设置组件的入参。
 */
interface ThemeModeSectionProps {
  value: ThemeMode;
  onChange: (next: ThemeMode) => void;
}

/**
 * 主题模式切换模块，允许选择亮/暗/跟随系统。
 */
const ThemeModeSection: React.FC<ThemeModeSectionProps> = ({ value, onChange }) => {
  const handleChange = useCallback(
    (nextValue: string) => {
      if (nextValue !== value) {
        onChange(nextValue as ThemeMode);
      }
    },
    [onChange, value],
  );

  return (
    <div className={styles.configSection}>
      <h3>主题设置</h3>
      <GlassSelector
        value={value}
        onChange={handleChange}
        options={THEME_OPTIONS}
        columns={3}
        label="主题模式"
        className={styles.themeSelector}
      />
    </div>
  );
};

export default ThemeModeSection;
