import React, { useCallback, useMemo } from 'react';
import { Slider } from 'antd-mobile';
import styles from '../index.module.scss';

/**
 * 语速基础配置模块的入参。
 */
interface SpeedConfigSectionProps {
  speed: number;
  onSpeedChange: (speed: number) => void;
}

/**
 * 支持调节的语速选项。
 */
const SPEED_OPTIONS = [0.8, 0.9, 0.95, 1.0, 1.05, 1.1, 1.5];

/**
 * 设置页面的语速配置模块，使用步进器控制语速。
 */
const SpeedConfigSection: React.FC<SpeedConfigSectionProps> = ({
  speed,
  onSpeedChange,
}) => {
  // 查找当前语速在选项中的索引，如果未匹配则默认为 1.0 的索引
  const currentIndex = useMemo(() => {
    const index = SPEED_OPTIONS.indexOf(speed);
    return index !== -1 ? index : SPEED_OPTIONS.indexOf(1.0);
  }, [speed]);

  // 生成 Slider 的刻度标记
  const marks = useMemo<Record<number, string>>(() => {
    return SPEED_OPTIONS.reduce((acc, option, index) => {
      // 仅标记首尾和中间的一些关键点，或者标记所有点
      // 为了保持界面整洁，这里我们标记所有点，但显示文本可以简化
      acc[index] = `${option}x`;
      return acc;
    }, {} as Record<number, string>);
  }, []);

  const handleSliderChange = useCallback(
    (value: number | number[]) => {
      const index = Array.isArray(value) ? value[0] : value;
      const nextSpeed = SPEED_OPTIONS[index];
      if (nextSpeed !== undefined && nextSpeed !== speed) {
        onSpeedChange(nextSpeed);
      }
    },
    [onSpeedChange, speed]
  );

  return (
    <div className={styles.configSection}>
      <h3>播放语速</h3>
      <div className={styles.configField}>
        <Slider
          className={styles.configSlider}
          min={0}
          max={SPEED_OPTIONS.length - 1}
          step={1}
          ticks
          marks={marks}
          value={currentIndex}
          onChange={handleSliderChange}
        />
      </div>
    </div>
  );
};

export default SpeedConfigSection;
