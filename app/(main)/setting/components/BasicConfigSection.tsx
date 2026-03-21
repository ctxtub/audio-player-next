import React, { useCallback, useMemo } from 'react';
import { Slider } from 'antd-mobile';
import styles from '../index.module.scss';

/**
 * 基础播放配置模块的入参。
 */
interface BasicConfigSectionProps {
  playDuration: number;
  onPlayDurationChange: (value: number) => void;
}

/**
 * 支持设置的最小时长（分钟）。
 */
const MIN_DURATION = 10;
/**
 * 支持设置的最大时长（分钟）。
 */
const MAX_DURATION = 60;
/**
 * 调整步长（分钟）。
 */
const STEP = 10;

/**
 * 设置页面的基础配置模块，控制播放时长。
 */
const BasicConfigSection: React.FC<BasicConfigSectionProps> = ({
  playDuration,
  onPlayDurationChange,
}) => {
  const marks = useMemo<Record<number, string>>(
    () => ({
      [MIN_DURATION]: `${MIN_DURATION}分钟`,
      [MIN_DURATION + STEP]: `${MIN_DURATION + STEP}分钟`,
      [MIN_DURATION + STEP * 2]: `${MIN_DURATION + STEP * 2}分钟`,
      [MIN_DURATION + STEP * 3]: `${MIN_DURATION + STEP * 3}分钟`,
      [MIN_DURATION + STEP * 4]: `${MIN_DURATION + STEP * 4}分钟`,
      [MAX_DURATION]: `${MAX_DURATION}分钟`,
    }),
    []
  );

  const handleChange = useCallback(
    (next: number | number[]) => {
      const numericValue = Array.isArray(next) ? next[0] ?? MIN_DURATION : next;
      const normalized = numericValue;
      if (normalized !== playDuration) {
        onPlayDurationChange(normalized);
      }
    },
    [onPlayDurationChange, playDuration]
  );

  return (
    <div className={styles.configSection}>
      <h3>播放时长</h3>
      <div className={styles.configField}>
        <Slider
          className={styles.configSlider}
          min={MIN_DURATION}
          max={MAX_DURATION}
          step={STEP}
          ticks
          marks={marks}
          value={playDuration}
          onChange={handleChange}
        />
      </div>
    </div>
  );
};

export default BasicConfigSection;
