import React, { useCallback } from 'react';
import { Layers } from 'lucide-react';
import GlassSwitch from '@/components/ui/GlassSwitch';
import styles from '../index.module.scss';

/**
 * 桌面悬浮播放开关组件的入参（M6 领域语义）。
 */
interface DesktopFloatingPlayerSectionProps {
  /** 宽屏是否启用悬浮迷你播放器；false=固定在底部导航上方。 */
  value: boolean;
  /** 开关状态变化回调。 */
  onChange: (value: boolean) => void;
}

/**
 * 设置页面的桌面悬浮播放配置模块。
 * 账号级偏好：移动端始终使用固定迷你播放器，本开关仅桌面生效，但仍在手机上显示以便跨端配置。
 */
const DesktopFloatingPlayerSection: React.FC<DesktopFloatingPlayerSectionProps> = ({ value, onChange }) => {
  const handleChange = useCallback(
    (checked: boolean) => {
      onChange(checked);
    },
    [onChange]
  );

  return (
    <div className={styles.configSection}>
      <h3><Layers className={styles.rowIcon} strokeWidth={1.8} />桌面悬浮播放</h3>
      <div className={styles.configActionRow}>
        <p className={styles.configDescription}>开启后，在宽屏设备上可拖动迷你播放器。关闭后固定显示在底部导航上方。移动端始终使用固定迷你播放器（仅桌面生效）。</p>
        <GlassSwitch
          isSelected={value}
          onChange={handleChange}
          label="桌面悬浮播放开关"
        />
      </div>
    </div>
  );
};

export default DesktopFloatingPlayerSection;
