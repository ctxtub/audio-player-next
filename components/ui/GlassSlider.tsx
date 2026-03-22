'use client';

import React, { useMemo } from 'react';
import {
  Slider,
  SliderTrack,
  SliderThumb,
  SliderOutput,
  Label,
} from 'react-aria-components';
import styles from './GlassSlider.module.scss';

/**
 * GlassSlider 入参。
 */
export interface GlassSliderProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  marks?: Record<number, string>;
  label?: string;
  className?: string;
}

/**
 * Liquid Glass 风格滑块，替代 antd-mobile Slider。
 */
const GlassSlider: React.FC<GlassSliderProps> = ({
  value,
  onChange,
  min,
  max,
  step = 1,
  marks,
  label,
  className = '',
}) => {
  const percentage = ((value - min) / (max - min)) * 100;

  /** 刻度标记列表 */
  const markEntries = useMemo(() => {
    if (!marks) return [];
    return Object.entries(marks).map(([k, v]) => ({
      position: ((Number(k) - min) / (max - min)) * 100,
      numValue: Number(k),
      label: v,
    }));
  }, [marks, min, max]);

  return (
    <Slider
      value={value}
      onChange={onChange}
      minValue={min}
      maxValue={max}
      step={step}
      className={`${styles.sliderRoot} ${className}`}
    >
      {label && <Label className={styles.label}>{label}</Label>}
      <SliderOutput className={styles.output}>
        {({ state }) => state.getThumbValueLabel(0)}
      </SliderOutput>
      <SliderTrack className={styles.track}>
        {/* 填充轨道 */}
        <div className={styles.fill} style={{ width: `${percentage}%` }} />

        {/* 刻度点 */}
        {markEntries.length > 0 && (
          <div className={styles.ticks}>
            {markEntries.map(({ position, numValue }) => (
              <div
                key={numValue}
                className={`${styles.tick} ${numValue <= value ? styles.tickActive : ''}`}
                style={{ left: `${position}%` }}
              />
            ))}
          </div>
        )}

        <SliderThumb className={styles.thumb} />
      </SliderTrack>

      {/* 刻度标签 */}
      {markEntries.length > 0 && (
        <div className={styles.markLabels}>
          {markEntries.map(({ position, numValue, label: markLabel }) => (
            <span
              key={numValue}
              className={`${styles.markLabel} ${numValue === value ? styles.markLabelActive : ''}`}
              style={{ left: `${position}%` }}
            >
              {markLabel}
            </span>
          ))}
        </div>
      )}
    </Slider>
  );
};

export default GlassSlider;
