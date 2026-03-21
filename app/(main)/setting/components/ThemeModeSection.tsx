'use client';

import React, { useCallback } from 'react';
import { Selector } from 'antd-mobile';
import type { ThemeMode } from '@/types/theme';
import styles from '../index.module.scss';

/**
 * 主题选项的元数据结构。
 */
interface ThemeOptionMeta {
  value: ThemeMode;
  label: string;
  icon: string;
}

/**
 * 可供选择的主题模式列表。
 */
const THEME_OPTIONS: ThemeOptionMeta[] = [
  {
    value: 'light',
    label: '亮色模式',
    icon: '☀️',
  },
  {
    value: 'dark',
    label: '暗色模式',
    icon: '🌙',
  },
  {
    value: 'system',
    label: '跟随系统',
    icon: '🌓',
  },
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
    (values: string[]) => {
      const [nextValue] = values as ThemeMode[];
      if (!nextValue || nextValue === value) {
        return;
      }
      onChange(nextValue);
    },
    [onChange, value],
  );

  return (
    <div className={styles.configSection}>
      <h3>主题设置</h3>
      <Selector
        className={styles.themeSelector}
        columns={3}
        value={[value]}
        onChange={handleChange}
        options={THEME_OPTIONS.map(option => ({
          label: (
            <div className={styles.themeOption}>
              <span className={styles.themeOptionIcon} aria-hidden>
                {option.icon}
              </span>
              <div className={styles.themeOptionContent}>
                <span className={styles.themeOptionLabel}>{option.label}</span>
              </div>
            </div>
          ),
          value: option.value,
        }))}
      />
    </div>
  );
};

export default ThemeModeSection;
