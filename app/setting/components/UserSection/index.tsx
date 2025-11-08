'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, NoticeBar, Toast } from 'antd-mobile';

import Modal, { useModal } from '@/components/Modal';
import { useAuthStore } from '@/stores/authStore';

import styles from './index.module.scss';

/**
 * 设置页顶部的用户信息模块组件。
 * @returns 用户信息区域与登录弹窗。
 */
const UserSection: React.FC = () => {
  const isLogin = useAuthStore(state => state.isLogin);
  const nickname = useAuthStore(state => state.nickname);
  const loading = useAuthStore(state => state.loading);
  const initialized = useAuthStore(state => state.initialized);
  const storeError = useAuthStore(state => state.error);
  const doLogin = useAuthStore(state => state.login);
  const doLogout = useAuthStore(state => state.logout);
  const resetError = useAuthStore(state => state.resetError);

  const { isShow, showModal, closeModal } = useModal();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (storeError && isShow) {
      setFormError(storeError);
    }
  }, [storeError, isShow]);

  const displayNickname = useMemo(() => {
    if (isLogin && nickname) {
      return nickname;
    }
    if (!initialized) {
      return '状态同步中...';
    }
    return '未登录';
  }, [initialized, isLogin, nickname]);

  const statusText = useMemo(() => {
    if (isLogin) {
      return '已登录';
    }
    return initialized ? '请登录以同步个性化配置' : '正在检查登录状态';
  }, [initialized, isLogin]);

  const handleOpenModal = useCallback(() => {
    setUsername('');
    setPassword('');
    setSubmitting(false);
    setFormError(null);
    resetError();
    showModal();
  }, [resetError, showModal]);

  const handleCloseModal = useCallback(() => {
    closeModal();
    setSubmitting(false);
    setFormError(null);
    resetError();
  }, [closeModal, resetError]);

  const handleLogin = useCallback(async () => {
    const trimmedUsername = username.trim();
    const trimmedPassword = password.trim();

    if (!trimmedUsername || !trimmedPassword) {
      setFormError('请输入账号和密码');
      return;
    }

    setSubmitting(true);
    setFormError(null);
    resetError();

    const success = await doLogin(trimmedUsername, trimmedPassword);
    setSubmitting(false);

    if (success) {
      Toast.show({ icon: 'success', content: '登录成功' });
      handleCloseModal();
      return;
    }

    const latestError = useAuthStore.getState().error;
    setFormError(latestError || '登录失败，请稍后重试');
  }, [doLogin, handleCloseModal, password, resetError, username]);

  const handleLogout = useCallback(async () => {
    const success = await doLogout();
    if (success) {
      Toast.show({ icon: 'success', content: '已登出' });
    } else {
      const latestError = useAuthStore.getState().error;
      Toast.show({ icon: 'fail', content: latestError || '登出失败，请稍后重试' });
    }
  }, [doLogout]);

  const actionButton = isLogin ? (
    <Button
      color="primary"
      size="small"
      loading={loading}
      className={styles.logoutButton}
      onClick={handleLogout}
    >
      登出
    </Button>
  ) : (
    <Button
      color="primary"
      size="small"
      loading={loading}
      className={styles.loginButton}
      onClick={handleOpenModal}
    >
      登录
    </Button>
  );

  return (
    <>
      <div className={styles.userSection}>
        <div className={styles.userInfo}>
          <span className={styles.nickname}>{displayNickname}</span>
          <span className={styles.status}>{statusText}</span>
        </div>
        <div className={styles.actions}>{actionButton}</div>
      </div>

      <Modal isShow={isShow} title="账号登录" onClose={handleCloseModal}>
        <div className={styles.loginForm}>
          {formError && (
            <NoticeBar color="alert" className={styles.errorBar} content={formError} />
          )}
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="login-username">
              账号
            </label>
            <Input
              id="login-username"
              placeholder="请输入账号"
              value={username}
              onChange={val => setUsername(val)}
              clearable
              disabled={submitting}
            />
          </div>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="login-password">
              密码
            </label>
            <Input
              id="login-password"
              type="password"
              placeholder="请输入密码"
              value={password}
              onChange={val => setPassword(val)}
              clearable
              disabled={submitting}
            />
          </div>
          <div className={styles.formActions}>
            <Button
              color="primary"
              block
              loading={submitting}
              onClick={handleLogin}
            >
              登录
            </Button>
            <Button onClick={handleCloseModal} disabled={submitting}>
              取消
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
};

export default UserSection;
