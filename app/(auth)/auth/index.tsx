'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Button,
  Form,
  TextField,
  Input,
  Label,
  FieldError,
  TabList,
  TabPanel,
  Tabs,
  Tab,
} from 'react-aria-components';

import { Music, User, Lock, Smile } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import styles from './index.module.scss';

/**
 * 安全重定向：校验 from 参数必须是相对路径，防止 open redirect。
 */
const safeRedirect = (from: string | null): string => {
  if (!from) return '/chat';
  if (!from.startsWith('/') || from.startsWith('//')) return '/chat';
  return from;
};

/**
 * Auth 页面组件 — 使用 React Aria Components + Liquid Glass 风格。
 */
const AuthPage: React.FC = () => {
  const router = useRouter();
  const searchParams = useSearchParams();

  const doLogin = useAuthStore(state => state.login);
  const doRegister = useAuthStore(state => state.register);
  const doEnterGuestMode = useAuthStore(state => state.enterGuestMode);
  const storeError = useAuthStore(state => state.error);
  const resetError = useAuthStore(state => state.resetError);

  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');
  const [apiError, setApiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /* 登录表单状态 */
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  /* 注册表单状态 */
  const [regUsername, setRegUsername] = useState('');
  const [regNickname, setRegNickname] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirmPwd, setRegConfirmPwd] = useState('');

  const from = searchParams.get('from');

  useEffect(() => {
    if (storeError) setApiError(storeError);
  }, [storeError]);

  /** 切换 Tab 时重置表单和错误 */
  const handleTabChange = useCallback((key: React.Key) => {
    setActiveTab(key as 'login' | 'register');
    setApiError(null);
    resetError();
    setLoginUsername('');
    setLoginPassword('');
    setRegUsername('');
    setRegNickname('');
    setRegPassword('');
    setRegConfirmPwd('');
  }, [resetError]);

  const handleSuccess = useCallback(() => {
    router.replace(safeRedirect(from));
  }, [from, router]);

  /** 通用提交逻辑 */
  const handleSubmit = useCallback(async (
    action: () => Promise<boolean>,
    fallbackError: string,
  ) => {
    setSubmitting(true);
    setApiError(null);
    resetError();
    try {
      const success = await action();
      if (success) {
        handleSuccess();
        return;
      }
      // action 失败时 store.error 已被设置，通过 useEffect 同步至 apiError；
      // 此处仅设置兜底消息，避免 store.error 尚未同步时界面无反馈。
      const currentError = useAuthStore.getState().error;
      if (currentError) {
        setApiError(currentError);
      } else {
        setApiError(fallbackError);
      }
    } catch {
      setApiError(fallbackError);
    } finally {
      setSubmitting(false);
    }
  }, [handleSuccess, resetError]);

  /** 登录提交 */
  const handleLoginSubmit = useCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    handleSubmit(
      () => doLogin(loginUsername.trim(), loginPassword.trim()),
      '登录失败，请稍后重试',
    );
  }, [doLogin, handleSubmit, loginUsername, loginPassword]);

  /** 注册提交 */
  const handleRegisterSubmit = useCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    handleSubmit(
      () => doRegister(regUsername.trim(), regPassword.trim(), regNickname.trim() || undefined),
      '注册失败，请稍后重试',
    );
  }, [doRegister, handleSubmit, regUsername, regPassword, regNickname]);

  /** 访客模式 */
  const handleGuestMode = useCallback(async () => {
    setSubmitting(true);
    try {
      const success = await doEnterGuestMode();
      if (success) {
        router.replace(safeRedirect(from));
      }
    } finally {
      setSubmitting(false);
    }
  }, [doEnterGuestMode, from, router]);

  /** 清除输入时的错误 */
  const clearError = useCallback(() => {
    if (apiError) setApiError(null);
  }, [apiError]);

  return (
    <div className={styles.page}>
      {/* Logo 区 */}
      <div className={styles.header}>
        <div className={styles.logo}><Music size={32} strokeWidth={1.8} /></div>
        <h1 className={styles.appName}>故事工坊</h1>
        <p className={styles.tagline}>智能故事，随时聆听</p>
      </div>

      {/* Liquid Glass 表单卡片 */}
      <Tabs
        selectedKey={activeTab}
        onSelectionChange={handleTabChange}
        className={styles.card}
      >
        <TabList className={styles.tabHeader} aria-label="登录或注册">
          <Tab id="login" className={({ isSelected }) =>
            `${styles.tabBtn} ${isSelected ? styles.tabBtnActive : ''}`
          }>
            登录
          </Tab>
          <Tab id="register" className={({ isSelected }) =>
            `${styles.tabBtn} ${isSelected ? styles.tabBtnActive : ''}`
          }>
            注册
          </Tab>
        </TabList>

        {/* 登录面板 */}
        <TabPanel id="login" className={styles.formWrapper}>
          <Form onSubmit={handleLoginSubmit} className={styles.form}>
            {apiError && (
              <div className={styles.apiErrorBar} role="alert">{apiError}</div>
            )}

            <TextField
              isRequired
              isDisabled={submitting}
              className={styles.fieldGroup}
              onChange={(v) => { setLoginUsername(v); clearError(); }}
              value={loginUsername}
            >
              <Label className={styles.srOnly}>账号</Label>
              <div className={styles.inputRow}>
                <span className={styles.inputIcon}><User size={18} strokeWidth={1.8} /></span>
                <Input
                  className={styles.input}
                  placeholder="账号"
                  autoComplete="username"
                />
              </div>
              <FieldError className={styles.fieldError} />
            </TextField>

            <TextField
              isRequired
              isDisabled={submitting}
              className={styles.fieldGroup}
              onChange={(v) => { setLoginPassword(v); clearError(); }}
              value={loginPassword}
              type="password"
            >
              <Label className={styles.srOnly}>密码</Label>
              <div className={styles.inputRow}>
                <span className={styles.inputIcon}><Lock size={18} strokeWidth={1.8} /></span>
                <Input
                  className={styles.input}
                  placeholder="密码"
                  autoComplete="current-password"
                />
              </div>
              <FieldError className={styles.fieldError} />
            </TextField>

            <div className={styles.formFooter}>
              <Button
                type="submit"
                isDisabled={submitting}
                className={styles.submitButton}
              >
                {submitting ? '登录中…' : '登录'}
              </Button>
            </div>
          </Form>
        </TabPanel>

        {/* 注册面板 */}
        <TabPanel id="register" className={styles.formWrapper}>
          <Form onSubmit={handleRegisterSubmit} className={styles.form}>
            {apiError && (
              <div className={styles.apiErrorBar} role="alert">{apiError}</div>
            )}

            <TextField
              isRequired
              minLength={2}
              isDisabled={submitting}
              className={styles.fieldGroup}
              onChange={(v) => { setRegUsername(v); clearError(); }}
              value={regUsername}
            >
              <Label className={styles.srOnly}>账号</Label>
              <div className={styles.inputRow}>
                <span className={styles.inputIcon}><User size={18} strokeWidth={1.8} /></span>
                <Input
                  className={styles.input}
                  placeholder="账号（至少 2 个字符）"
                  autoComplete="username"
                />
              </div>
              <FieldError className={styles.fieldError} />
            </TextField>

            <TextField
              isDisabled={submitting}
              className={styles.fieldGroup}
              onChange={(v) => { setRegNickname(v); clearError(); }}
              value={regNickname}
            >
              <Label className={styles.srOnly}>昵称</Label>
              <div className={styles.inputRow}>
                <span className={styles.inputIcon}><Smile size={18} strokeWidth={1.8} /></span>
                <Input
                  className={styles.input}
                  placeholder="昵称（可选）"
                  autoComplete="nickname"
                />
              </div>
            </TextField>

            <TextField
              isRequired
              minLength={6}
              isDisabled={submitting}
              className={styles.fieldGroup}
              onChange={(v) => { setRegPassword(v); clearError(); }}
              value={regPassword}
              type="password"
            >
              <Label className={styles.srOnly}>密码</Label>
              <div className={styles.inputRow}>
                <span className={styles.inputIcon}><Lock size={18} strokeWidth={1.8} /></span>
                <Input
                  className={styles.input}
                  placeholder="密码（至少 6 个字符）"
                  autoComplete="new-password"
                />
              </div>
              <FieldError className={styles.fieldError} />
            </TextField>

            <TextField
              isRequired
              isDisabled={submitting}
              className={styles.fieldGroup}
              onChange={(v) => { setRegConfirmPwd(v); clearError(); }}
              value={regConfirmPwd}
              type="password"
              validate={(value) => {
                if (value !== regPassword) return '两次输入的密码不一致';
                return null;
              }}
            >
              <Label className={styles.srOnly}>确认密码</Label>
              <div className={styles.inputRow}>
                <span className={styles.inputIcon}><Lock size={18} strokeWidth={1.8} /></span>
                <Input
                  className={styles.input}
                  placeholder="确认密码"
                  autoComplete="new-password"
                />
              </div>
              <FieldError className={styles.fieldError} />
            </TextField>

            <div className={styles.formFooter}>
              <Button
                type="submit"
                isDisabled={submitting}
                className={styles.submitButton}
              >
                {submitting ? '注册中…' : '注册'}
              </Button>
            </div>
          </Form>
        </TabPanel>
      </Tabs>

      {/* 访客模式入口 */}
      <div className={styles.guestSection}>
        <div className={styles.divider}>
          <span className={styles.dividerText}>或</span>
        </div>
        <Button
          isDisabled={submitting}
          onPress={handleGuestMode}
          className={styles.guestButton}
        >
          以访客身份继续使用
        </Button>
      </div>
    </div>
  );
};

export default AuthPage;
