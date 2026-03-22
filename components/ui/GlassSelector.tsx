'use client';

import React from 'react';
import {
  RadioGroup,
  Radio,
  Label,
} from 'react-aria-components';
import styles from './GlassSelector.module.scss';

/**
 * 选项定义。
 */
export interface GlassSelectorOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
}

/**
 * GlassSelector 入参。
 */
export interface GlassSelectorProps<T extends string = string> {
  value: T;
  onChange: (value: T) => void;
  options: GlassSelectorOption<T>[];
  columns?: number;
  label?: string;
  className?: string;
}

/**
 * Liquid Glass 风格单选按钮组，替代 antd-mobile Selector。
 */
function GlassSelector<T extends string = string>({
  value,
  onChange,
  options,
  columns = 3,
  label,
  className = '',
}: GlassSelectorProps<T>) {
  return (
    <RadioGroup
      value={value}
      onChange={(v) => onChange(v as T)}
      className={`${styles.selectorGroup} ${className}`}
      aria-label={label}
    >
      {label && <Label className={styles.srOnly}>{label}</Label>}
      <div
        className={styles.selectorGrid}
        style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
      >
        {options.map((option) => (
          <Radio
            key={option.value}
            value={option.value}
            className={({ isSelected }) =>
              `${styles.selectorItem} ${isSelected ? styles.selected : ''}`
            }
          >
            {option.label}
          </Radio>
        ))}
      </div>
    </RadioGroup>
  );
}

export default GlassSelector;
