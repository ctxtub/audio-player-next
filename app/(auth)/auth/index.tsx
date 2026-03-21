'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Form, Input } from 'antd-mobile';
import { LockOutline, UserOutline } from 'antd-mobile-icons';

import { useAuthStore } from '@/stores/authStore';
import styles from './index.module.scss';

interface LoginFormValues {
  username: string;
  password: string;
}

interface RegisterFormValues {
  username: string;
  nickname?: string;
  password: string;
  confirmPassword: string;
}

/**
 * 安全重定向：校验 from 参数必须是相对路径，防止 open redirect。
 */
const safeRedirect = (from: string | null): string => {
  if (!from) return '/home';
  if (!from.startsWith('/') || from.startsWith('//')) return '/home';
  return from;
};

const AuthPage: React.FC = () => {
  const router = useRouter();
  const searchParams = useSearchParams();

  const doLogin = useAuthStore(state => state.login);
  const doRegister = useAuthStore(state => state.register);
  const doEnterGuestMode = useAuthStore(state => state.enterGuestMode);
  const storeError = useAuthStore(state => state.error);
  const resetError = useAuthStore(state => state.resetError);

  const [loginForm] = Form.useForm<LoginFormValues>();
  const [registerForm] = Form.useForm<RegisterFormValues>();
  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');
  const [apiError, setApiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const from = searchParams.get('from');

  useEffect(() => {
    if (storeError) setApiError(storeError);
  }, [storeError]);

  const handleTabChange = useCallback((key: 'login' | 'register') => {
    setActiveTab(key);
    setApiError(null);
    resetError();
    loginForm.resetFields();
    registerForm.resetFields();
  }, [loginForm, registerForm, resetError]);

  const handleSuccess = useCallback(() => {
    router.replace(safeRedirect(from));
  }, [from, router]);

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
      setApiError(useAuthStore.getState().error || fallbackError);
    } catch {
      setApiError(fallbackError);
    } finally {
      setSubmitting(false);
    }
  }, [handleSuccess, resetError]);

  const handleLoginFinish = useCallback(async (values: LoginFormValues) => {
    await handleSubmit(
      () => doLogin(values.username.trim(), values.password.trim()),
      '登录失败，请稍后重试',
    );
  }, [doLogin, handleSubmit]);

  const handleRegisterFinish = useCallback(async (values: RegisterFormValues) => {
    await handleSubmit(
      () => doRegister(values.username.trim(), values.password.trim(), values.nickname?.trim() || undefined),
      '注册失败，请稍后重试',
    );
  }, [doRegister, handleSubmit]);

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

  const formFooter = (onSubmit: () => void, label: string) => (
    <div className={styles.formFooter}>
      <Button color="primary" block loading={submitting} type="button" onClick={onSubmit}>
        {label}
      </Button>
    </div>
  );

  return (
    <div className={styles.page}>
      {/* Logo 区 */}
      <div className={styles.header}>
        <div className={styles.logo}>🎵</div>
        <h1 className={styles.appName}>AI 播放器</h1>
        <p className={styles.tagline}>智能故事，随时聆听</p>
      </div>

      {/* 表单卡片 */}
      <div className={styles.card}>
        {/* 自定义 Tab 头：避免 antd-mobile Tabs 的 JS 固定高度机制截断表单内容 */}
        <div className={styles.tabHeader}>
          <button
            className={`${styles.tabBtn} ${activeTab === 'login' ? styles.tabBtnActive : ''}`}
            onClick={() => handleTabChange('login')}
            type="button"
          >
            登录
          </button>
          <button
            className={`${styles.tabBtn} ${activeTab === 'register' ? styles.tabBtnActive : ''}`}
            onClick={() => handleTabChange('register')}
            type="button"
          >
            注册
          </button>
        </div>

        {/* 登录表单 */}
        {activeTab === 'login' && (
          <div className={styles.formWrapper}>
            <Form
              form={loginForm}
              layout="vertical"
              className={styles.form}
              onFinish={handleLoginFinish}
              onValuesChange={() => { if (apiError) setApiError(null); }}
              initialValues={{ username: '', password: '' }}
              footer={formFooter(() => loginForm.submit(), '登录')}
            >
              {apiError && (
                <div className={styles.apiErrorBar}>{apiError}</div>
              )}
              <Form.Item name="username" rules={[{ required: true, message: '请输入账号' }]}>
                <div className={styles.inputRow}>
                  <UserOutline className={styles.inputIcon} />
                  <Input placeholder="账号" clearable disabled={submitting} className={styles.input} autoComplete="username" />
                </div>
              </Form.Item>
              <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
                <div className={styles.inputRow}>
                  <LockOutline className={styles.inputIcon} />
                  <Input type="password" placeholder="密码" clearable disabled={submitting} className={styles.input} autoComplete="current-password" />
                </div>
              </Form.Item>
            </Form>
          </div>
        )}

        {/* 注册表单 */}
        {activeTab === 'register' && (
          <div className={styles.formWrapper}>
            <Form
              form={registerForm}
              layout="vertical"
              className={styles.form}
              onFinish={handleRegisterFinish}
              onValuesChange={() => { if (apiError) setApiError(null); }}
              initialValues={{ username: '', nickname: '', password: '', confirmPassword: '' }}
              footer={formFooter(() => registerForm.submit(), '注册')}
            >
              {apiError && (
                <div className={styles.apiErrorBar}>{apiError}</div>
              )}
              <Form.Item
                name="username"
                rules={[
                  { required: true, message: '请输入账号' },
                  { min: 2, message: '账号至少 2 个字符' },
                ]}
              >
                <div className={styles.inputRow}>
                  <UserOutline className={styles.inputIcon} />
                  <Input placeholder="账号" clearable disabled={submitting} className={styles.input} autoComplete="username" />
                </div>
              </Form.Item>
              <Form.Item name="nickname">
                <div className={styles.inputRow}>
                  <UserOutline className={styles.inputIcon} />
                  <Input placeholder="昵称（可选）" clearable disabled={submitting} className={styles.input} autoComplete="nickname" />
                </div>
              </Form.Item>
              <Form.Item
                name="password"
                rules={[
                  { required: true, message: '请输入密码' },
                  { min: 6, message: '密码至少 6 个字符' },
                ]}
              >
                <div className={styles.inputRow}>
                  <LockOutline className={styles.inputIcon} />
                  <Input type="password" placeholder="密码" clearable disabled={submitting} className={styles.input} autoComplete="new-password" />
                </div>
              </Form.Item>
              <Form.Item
                name="confirmPassword"
                dependencies={['password']}
                rules={[
                  { required: true, message: '请再次输入密码' },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      if (!value || getFieldValue('password') === value) {
                        return Promise.resolve();
                      }
                      return Promise.reject(new Error('两次输入的密码不一致'));
                    },
                  }),
                ]}
              >
                <div className={styles.inputRow}>
                  <LockOutline className={styles.inputIcon} />
                  <Input type="password" placeholder="确认密码" clearable disabled={submitting} className={styles.input} autoComplete="new-password" />
                </div>
              </Form.Item>
            </Form>
          </div>
        )}
      </div>

      {/* 访客模式入口 */}
      <div className={styles.guestSection}>
        <div className={styles.divider}>
          <span className={styles.dividerText}>或</span>
        </div>
        <Button
          block
          className={styles.guestButton}
          loading={submitting}
          onClick={handleGuestMode}
        >
          以访客身份继续使用
        </Button>
      </div>
    </div>
  );
};

export default AuthPage;
