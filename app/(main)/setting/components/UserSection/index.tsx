'use client';

import React, { useCallback, useEffect, useMemo } from 'react';
import { Button, Toast } from 'antd-mobile';
import { useRouter } from 'next/navigation';

import { useAuthStore } from '@/stores/authStore';
import styles from './index.module.scss';

/**
 * 用户信息区域：展示头像、昵称与登出按钮（或引导登录入口）。
 */
const UserSection: React.FC = () => {
  const isLogin = useAuthStore(state => state.isLogin);
  const isGuest = useAuthStore(state => state.isGuest);
  const nickname = useAuthStore(state => state.nickname);
  const loading = useAuthStore(state => state.loading);
  const initialized = useAuthStore(state => state.initialized);
  const fetchProfile = useAuthStore(state => state.fetchProfile);
  const doLogout = useAuthStore(state => state.logout);

  const router = useRouter();

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const displayNickname = useMemo(() => {
    if (isLogin && nickname) return nickname;
    if (isGuest) return '访客';
    if (!initialized) return '同步中...';
    return '未登录';
  }, [initialized, isGuest, isLogin, nickname]);

  const statusText = useMemo(() => {
    if (isLogin) return '已登录';
    if (isGuest) return '访客模式 · 数据不会保存';
    return initialized ? '登录后解锁全部功能' : '正在检查登录状态';
  }, [initialized, isGuest, isLogin]);

  const avatarChar = useMemo(() => {
    if (isLogin && nickname) return nickname.slice(0, 1).toUpperCase();
    if (isGuest) return '访';
    return '?';
  }, [isGuest, isLogin, nickname]);

  const handleLogout = useCallback(async () => {
    const success = await doLogout();
    if (success) {
      Toast.show({ icon: 'success', content: '已登出' });
      router.push('/auth');
    } else {
      Toast.show({ icon: 'fail', content: useAuthStore.getState().error || '登出失败' });
    }
  }, [doLogout, router]);

  const handleGoAuth = useCallback(() => {
    router.push('/auth?from=/setting');
  }, [router]);

  const actionButton = isLogin ? (
    <Button color="primary" size="small" loading={loading} className={styles.actionButton} onClick={handleLogout}>
      登出
    </Button>
  ) : (
    <Button color="primary" size="small" loading={loading} className={styles.actionButton} onClick={handleGoAuth}>
      {isGuest ? '去注册' : '去登录'}
    </Button>
  );

  return (
    <div className={styles.userSection}>
      <div className={`${styles.avatar}${isGuest ? ` ${styles.avatarGuest}` : ''}`}>
        {avatarChar}
      </div>
      <div className={styles.userInfo}>
        <span className={styles.nickname}>{displayNickname}</span>
        <span className={styles.status}>{statusText}</span>
      </div>
      <div className={styles.actions}>{actionButton}</div>
    </div>
  );
};

export default UserSection;
