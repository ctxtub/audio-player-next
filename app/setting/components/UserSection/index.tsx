'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, ErrorBlock, Form, Input, Toast } from 'antd-mobile';
import type { ValidateErrorEntity } from 'rc-field-form/lib/interface';
import { LockOutline, UserOutline } from 'antd-mobile-icons';

import Modal, { useModal } from '@/components/Modal';
import { useAuthStore } from '@/stores/authStore';

import styles from './index.module.scss';

/**
 * 登录表单字段结构。
 * - username：用户账号。
 * - password：用户密码。
 */
interface LoginFormValues {
  username: string;
  password: string;
}

/**
 * antd-mobile 登录表单校验失败时返回的结构体类型。
 */
type LoginFormFailed = ValidateErrorEntity<LoginFormValues>;

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

  const [form] = Form.useForm<LoginFormValues>();
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
    form.resetFields();
    setSubmitting(false);
    setFormError(null);
    resetError();
    showModal();
  }, [form, resetError, showModal]);

  const handleCloseModal = useCallback(() => {
    closeModal();
    setSubmitting(false);
    setFormError(null);
    resetError();
    form.resetFields();
  }, [closeModal, form, resetError]);

  /**
   * 处理登录表单完成时的登录逻辑。
   * @param values 表单输入的账号与密码。
   */
  const handleFinish = useCallback(
    async (values: LoginFormValues) => {
      const trimmedUsername = values.username?.trim() ?? '';
      const trimmedPassword = values.password?.trim() ?? '';

      form.setFieldsValue({
        username: trimmedUsername,
        password: trimmedPassword,
      });

      if (!trimmedUsername || !trimmedPassword) {
        setFormError('请输入账号和密码');
        form.setFields([
          {
            name: 'username',
            errors: trimmedUsername ? [] : ['请输入账号'],
          },
          {
            name: 'password',
            errors: trimmedPassword ? [] : ['请输入密码'],
          },
        ]);
        return;
      }

      setSubmitting(true);
      setFormError(null);
      resetError();

      try {
        const success = await doLogin(trimmedUsername, trimmedPassword);

        if (success) {
          Toast.show({ icon: 'success', content: '登录成功' });
          handleCloseModal();
          return;
        }

        const latestError = useAuthStore.getState().error;
        setFormError(latestError || '登录失败，请稍后重试');
      } catch {
        setFormError('登录失败，请稍后重试');
      } finally {
        setSubmitting(false);
      }
    },
    [doLogin, form, handleCloseModal, resetError],
  );

  /**
   * 处理登录表单校验失败时的提示。
   * @param errors antd-mobile 表单返回的错误信息。
   */
  const handleFinishFailed = useCallback((errors: LoginFormFailed) => {
    const firstError = errors.errorFields?.[0]?.errors?.[0];
    if (firstError) {
      setFormError(firstError);
      return;
    }
    setFormError('请检查账号与密码填写是否完整');
  }, []);

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
        <Card className={styles.loginCard} bodyClassName={styles.loginCardBody}>
          <div className={styles.formWrapper}>
            {formError && (
              <ErrorBlock className={styles.errorBlock} status="default" title={formError} />
            )}
            <Form
              form={form}
              layout="vertical"
              className={styles.loginForm}
              onFinish={handleFinish}
              onFinishFailed={handleFinishFailed}
              onValuesChange={() => {
                if (formError) {
                  setFormError(null);
                }
              }}
              initialValues={{
                username: '',
                password: '',
              }}
              footer={
                <div className={styles.formFooter}>
                  <Button
                    color="primary"
                    block
                    loading={submitting}
                    type="button"
                    onClick={() => form.submit()}
                  >
                    登录
                  </Button>
                  <Button
                    block
                    className={styles.cancelButton}
                    onClick={handleCloseModal}
                    disabled={submitting}
                    type="button"
                  >
                    取消
                  </Button>
                </div>
              }
            >
              <Form.Item
                label="账号"
                name="username"
                rules={[{ required: true, message: '请输入账号' }]}
              >
                <div className={styles.inputRow}>
                  <UserOutline aria-hidden="true" className={styles.inputIcon} />
                  <Input
                    id="login-username"
                    placeholder="Account"
                    clearable
                    disabled={submitting}
                    className={styles.textInput}
                    aria-label="账号"
                    autoComplete="username"
                  />
                </div>
              </Form.Item>
              <Form.Item
                label="密码"
                name="password"
                rules={[{ required: true, message: '请输入密码' }]}
              >
                <div className={styles.inputRow}>
                  <LockOutline aria-hidden="true" className={styles.inputIcon} />
                  <Input
                    id="login-password"
                    type="password"
                    placeholder="Password"
                    clearable
                    disabled={submitting}
                    className={styles.textInput}
                    aria-label="密码"
                    autoComplete="current-password"
                  />
                </div>
              </Form.Item>
            </Form>
          </div>
        </Card>
      </Modal>
    </>
  );
};

export default UserSection;
