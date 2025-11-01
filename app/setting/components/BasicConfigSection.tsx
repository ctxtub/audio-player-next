import React, { useCallback, useMemo } from 'react';
import { Slider } from 'antd-mobile';
import styles from '../index.module.scss';

interface BasicConfigSectionProps {
  playDuration: number;
  onPlayDurationChange: (value: number) => void;
}

const MIN_DURATION = 10;
const MAX_DURATION = 60;
const STEP = 10;

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
      <h3>基础配置</h3>
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
