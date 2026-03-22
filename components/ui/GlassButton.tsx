'use client';

import React from 'react';
import { Button as AriaButton } from 'react-aria-components';
import type { ButtonProps as AriaButtonProps } from 'react-aria-components';
import styles from './GlassButton.module.scss';

/**
 * GlassButton 变体类型。
 */
export type GlassButtonVariant = 'primary' | 'outline' | 'ghost';

/**
 * GlassButton 尺寸。
 */
export type GlassButtonSize = 'sm' | 'md' | 'lg';

/**
 * 通用 Liquid Glass 风格按钮组件。
 */
export interface GlassButtonProps extends Omit<AriaButtonProps, 'className' | 'style'> {
  variant?: GlassButtonVariant;
  size?: GlassButtonSize;
  block?: boolean;
  loading?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * Liquid Glass 风格按钮，基于 React Aria Button。
 */
const GlassButton: React.FC<GlassButtonProps> = ({
  variant = 'primary',
  size = 'md',
  block = false,
  loading = false,
  className = '',
  children,
  isDisabled,
  ...rest
}) => {
  const classNames = [
    styles.glassButton,
    styles[variant],
    styles[size],
    block ? styles.block : '',
    loading ? styles.loading : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <AriaButton
      isDisabled={isDisabled || loading}
      className={classNames}
      {...rest}
    >
      {loading ? <span className={styles.spinner} /> : children}
    </AriaButton>
  );
};

export default GlassButton;
