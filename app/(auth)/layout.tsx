import React from 'react';
import styles from './layout.module.scss';

/**
 * 认证页布局：全屏无底部导航，适用于登录/注册页。
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className={styles.authLayout}>
      {children}
    </div>
  );
}
