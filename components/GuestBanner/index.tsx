'use client';

import React, { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore } from '@/stores/authStore';
import styles from './index.module.scss';

/**
 * 访客模式提示条。仅在访客状态下显示，引导用户注册。
 */
const GuestBanner: React.FC = () => {
  const isGuest = useAuthStore(state => state.isGuest);
  const initialized = useAuthStore(state => state.initialized);
  const fetchProfile = useAuthStore(state => state.fetchProfile);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  if (!initialized || !isGuest) return null;

  const handleRegister = () => {
    router.push(`/auth?from=${encodeURIComponent(pathname)}`);
  };

  return (
    <div className={styles.banner}>
      <span className={styles.text}>访客模式 · 数据不会保存</span>
      <button className={styles.action} onClick={handleRegister}>
        注册账号 →
      </button>
    </div>
  );
};

export default GuestBanner;
