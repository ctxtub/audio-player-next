import React, { useCallback } from 'react';
import GlassSwitch from '@/components/ui/GlassSwitch';
import styles from '../index.module.scss';

/**
 * 浮动播放器开关组件的入参。
 */
interface FloatingPlayerSectionProps {
  /** 当前是否开启浮动播放器。 */
  value: boolean;
  /** 开关状态变化回调。 */
  onChange: (value: boolean) => void;
}

/**
 * 设置页面的浮动播放器配置模块，提供开关控制浮窗显隐。
 */
const FloatingPlayerSection: React.FC<FloatingPlayerSectionProps> = ({ value, onChange }) => {
  const handleChange = useCallback(
    (checked: boolean) => {
      onChange(checked);
    },
    [onChange]
  );

  return (
    <div className={styles.configSection}>
      <h3>播放浮窗</h3>
      <div className={styles.configActionRow}>
        <p className={styles.configDescription}>开启后，在其他页面也会展示播放浮窗</p>
        <GlassSwitch
          isSelected={value}
          onChange={handleChange}
          label="播放浮窗开关"
        />
      </div>
    </div>
  );
};

export default FloatingPlayerSection;
