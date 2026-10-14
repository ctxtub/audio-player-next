'use client';

import React, { useCallback } from 'react';
import { Palette } from 'lucide-react';
import type { ThemePalette } from '@/types/theme';
import GlassSelector from '@/components/ui/GlassSelector';
import styles from '../index.module.scss';
import paletteStyles from './ThemePaletteSection.module.scss';

const PALETTE_OPTIONS: { value: ThemePalette; label: React.ReactNode }[] = [
  {
    value: 'amber',
    label: (
      <div className={paletteStyles.paletteOption}>
        <div
          className={paletteStyles.swatch}
          style={{ background: 'linear-gradient(135deg, #F59E0B, #EA580C)' }}
        />
        <div className={paletteStyles.info}>
          <span className={paletteStyles.title}>暖琥珀</span>
          <span className={paletteStyles.desc}>温润治愈 · 默认推荐</span>
        </div>
      </div>
    ),
  },
  {
    value: 'midnight',
    label: (
      <div className={paletteStyles.paletteOption}>
        <div
          className={paletteStyles.swatch}
          style={{ background: 'linear-gradient(135deg, #E2C374, #C5A059)' }}
        />
        <div className={paletteStyles.info}>
          <span className={paletteStyles.title}>静谧星夜</span>
          <span className={paletteStyles.desc}>精装烫金 · 深邃典雅</span>
        </div>
      </div>
    ),
  },
  {
    value: 'forest',
    label: (
      <div className={paletteStyles.paletteOption}>
        <div
          className={paletteStyles.swatch}
          style={{ background: 'linear-gradient(135deg, #34D399, #059669)' }}
        />
        <div className={paletteStyles.info}>
          <span className={paletteStyles.title}>森林雨雾</span>
          <span className={paletteStyles.desc}>松针翠绿 · 呼吸放松</span>
        </div>
      </div>
    ),
  },
  {
    value: 'mocha',
    label: (
      <div className={paletteStyles.paletteOption}>
        <div
          className={paletteStyles.swatch}
          style={{ background: 'linear-gradient(135deg, #E0AF82, #9A5B2D)' }}
        />
        <div className={paletteStyles.info}>
          <span className={paletteStyles.title}>复古摩卡</span>
          <span className={paletteStyles.desc}>羊皮纸卷 · 暖香胡桃</span>
        </div>
      </div>
    ),
  },
];

interface ThemePaletteSectionProps {
  value: ThemePalette;
  onChange: (next: ThemePalette) => void;
}

/**
 * 调性色板选择组件，提供 4 套预制主题色切换。
 */
const ThemePaletteSection: React.FC<ThemePaletteSectionProps> = ({ value, onChange }) => {
  const handleChange = useCallback(
    (nextValue: string) => {
      if (nextValue !== value) {
        onChange(nextValue as ThemePalette);
      }
    },
    [onChange, value],
  );

  return (
    <div className={styles.configSection}>
      <h3>
        <Palette className={styles.rowIcon} strokeWidth={1.8} />
        调性色板
      </h3>
      <GlassSelector
        value={value}
        onChange={handleChange}
        options={PALETTE_OPTIONS}
        columns={2}
        label="调性色板"
        className={paletteStyles.selectorWrapper}
      />
    </div>
  );
};

export default ThemePaletteSection;
