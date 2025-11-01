'use client';

import React, { useCallback } from 'react';
import { Selector } from 'antd-mobile';
import { useTheme } from '@/components/ThemeProvider';
import type { ThemeMode } from '@/types/types';
import styles from '../index.module.scss';

interface ThemeOptionMeta {
  value: ThemeMode;
  label: string;
  icon: string;
}

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

const ThemeModeSection: React.FC = () => {
  const { themeMode, setThemeMode } = useTheme();

  const handleChange = useCallback(
    (values: string[]) => {
      const [nextValue] = values as ThemeMode[];
      if (!nextValue) {
        setThemeMode(themeMode);
        return;
      }
      if (nextValue !== themeMode) {
        setThemeMode(nextValue);
      }
    },
    [setThemeMode, themeMode],
  );

  return (
    <div className={styles.configSection}>
      <h3>主题设置</h3>
      <Selector
        className={styles.themeSelector}
        columns={3}
        value={[themeMode]}
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
