'use client';

import React from 'react';
import { Switch } from 'react-aria-components';
import styles from './GlassSwitch.module.scss';

/**
 * GlassSwitch 入参。
 */
export interface GlassSwitchProps {
  isSelected: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  className?: string;
}

/**
 * Liquid Glass 风格开关，替代 antd-mobile Switch。
 */
const GlassSwitch: React.FC<GlassSwitchProps> = ({
  isSelected,
  onChange,
  label,
  className = '',
}) => {
  return (
    <Switch
      isSelected={isSelected}
      onChange={onChange}
      className={`${styles.switchRoot} ${className}`}
      aria-label={label}
    >
      <div className={styles.track}>
        <div className={styles.thumb} />
      </div>
    </Switch>
  );
};

export default GlassSwitch;
