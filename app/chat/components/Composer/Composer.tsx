'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, TextArea, Toast } from 'antd-mobile';

import styles from './Composer.module.scss';

/**
 * 聊天输入组合组件的入参定义。
 */
export interface ComposerProps {
  /** 文本内容，外部可选控制。 */
  value?: string;
  /** 文本变化回调，返回最新内容。 */
  onChange?: (nextValue: string) => void;
  /** 提交回调，返回 Promise 以便上层处理 loading。 */
  onSubmit: (content: string) => Promise<void> | void;
  /** 禁用态开关，true 时不可输入或提交。 */
  disabled?: boolean;
  /** 发送中状态，由上层传入控制按钮 loading。 */
  isSending?: boolean;
  /** 输入占位文案，默认描述聊天提示。 */
  placeholder?: string;
  /** 左侧扩展插槽区域，可挂载语音、附件按钮。 */
  leftSlot?: React.ReactNode;
  /** 提交按钮文案，默认显示“发送”。 */
  submitText?: string;
}

/**
 * 聊天输入组合组件，封装多行自适应输入框与发送按钮，支持快捷键提交。
 */
const Composer: React.FC<ComposerProps> = ({
  value,
  onChange,
  onSubmit,
  disabled = false,
  isSending = false,
  placeholder = '输入你想说的话...\n支持 Shift+Enter 换行',
  leftSlot,
  submitText = '发送',
}) => {
  /** 本地输入状态，受控时以 props value 为准。 */
  const [internalValue, setInternalValue] = useState(value ?? '');
  /** 本地发送中状态，用于在 props isSending 前后衔接提交锁。 */
  const [isLocalSending, setIsLocalSending] = useState(false);

  /**
   * 同步外部受控的 value 变化，保持内部状态一致。
   */
  useEffect(() => {
    if (value !== undefined && value !== internalValue) {
      setInternalValue(value);
    }
  }, [value, internalValue]);

  /**
   * 计算禁用态，整合外部禁用与发送中的状态。
   */
  const effectiveDisabled = useMemo(
    () => disabled || isSending || isLocalSending,
    [disabled, isSending, isLocalSending],
  );

  /**
   * 空内容提示提醒用户补充输入。
   */
  const showEmptyContentWarning = useCallback(() => {
    Toast.show({
      icon: 'fail',
      content: '请输入内容后再发送哦~',
    });
  }, []);

  /**
   * 文本变化时更新内部状态并透出给外部。
   */
  const handleChange = useCallback(
    (next: string) => {
      setInternalValue(next);
      onChange?.(next);
    },
    [onChange],
  );

  /**
   * 提交发送逻辑，进行空值校验并处理异常 Toast。
   */
  const handleSubmit = useCallback(async () => {
    if (effectiveDisabled) {
      return;
    }

    const trimmed = internalValue.trim();
    if (!trimmed) {
      showEmptyContentWarning();
      return;
    }

    setIsLocalSending(true);
    try {
      await onSubmit(trimmed);
      handleChange('');
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : '发送失败，请稍后重试';
      Toast.show({ icon: 'fail', content: message });
    } finally {
      setIsLocalSending(false);
    }
  }, [effectiveDisabled, handleChange, internalValue, onSubmit, showEmptyContentWarning]);

  /**
   * 键盘回车快捷提交，支持 Shift+Enter 换行。
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (effectiveDisabled) {
        return;
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void handleSubmit();
      }
    },
    [effectiveDisabled, handleSubmit],
  );

  return (
    <div className={styles.container}>
      {leftSlot ? <div className={styles.leftSlot}>{leftSlot}</div> : null}
      <div className={styles.inputArea}>
        <div className={styles.textAreaWrapper}>
          <TextArea
            value={internalValue}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            disabled={effectiveDisabled}
            placeholder={placeholder}
            autoSize
            maxLength={5000}
            className={styles.textArea}
          />
        </div>
        <Button
          color="primary"
          loading={isSending || isLocalSending}
          disabled={effectiveDisabled}
          onClick={() => {
            void handleSubmit();
          }}
          className={styles.submitButton}
          fill="solid"
        >
          {submitText}
        </Button>
      </div>
    </div>
  );
};

export default Composer;
