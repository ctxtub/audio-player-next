'use client';

import React, { useCallback } from 'react';
import { Selector } from 'antd-mobile';
import type { ThemeMode } from '@/types/theme';
import {
  SECTION_CLASS,
  SECTION_TITLE_CLASS,
} from './sectionStyles';

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
    <div className={SECTION_CLASS}>
      <h3 className={SECTION_TITLE_CLASS}>主题设置</h3>
      <Selector
        className="w-full"
        columns={3}
        value={[value]}
        onChange={handleChange}
        options={THEME_OPTIONS.map(option => ({
          label: (
            <div className="flex items-center gap-3">
              <span className="text-2xl" aria-hidden>
                {option.icon}
              </span>
              <div className="flex flex-col items-start gap-1">
                <span className="text-[15px] font-semibold text-[var(--foreground)]">{option.label}</span>
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
