'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import GlassToast from '@/components/ui/GlassToast';
import GlassButton from '@/components/ui/GlassButton';
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
  /** 提交按钮文案，默认显示"发送"。 */
  submitText?: string;
  /** 清空回调，用于触发更广泛的重置逻辑。 */
  onClear?: () => void;
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
  placeholder = '请输入内容...',
  leftSlot,
  submitText = '发送',
  onClear,
}) => {
  /** 本地输入状态，受控时以 props value 为准。 */
  const [internalValue, setInternalValue] = useState(value ?? '');
  /** 本地发送中状态，用于在 props isSending 前后衔接提交锁。 */
  const [isLocalSending, setIsLocalSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * 同步外部受控的 value 变化，保持内部状态一致。
   */
  useEffect(() => {
    if (value !== undefined) {
      setInternalValue(value);
    }
  }, [value]);

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
    GlassToast.show({
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
   * 自动调整 textarea 高度。
   */
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }
  }, []);

  /**
   * textarea 输入事件处理。
   */
  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      handleChange(e.target.value);
      adjustHeight();
    },
    [handleChange, adjustHeight],
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
      // 重置高度
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : '发送失败，请稍后重试';
      GlassToast.show({ icon: 'fail', content: message });
    } finally {
      setIsLocalSending(false);
    }
  }, [effectiveDisabled, handleChange, internalValue, onSubmit, showEmptyContentWarning]);

  /**
   * 清空输入框内容。
   */
  const handleClear = useCallback(() => {
    if (disabled || isSending || isLocalSending) {
      return;
    }
    handleChange('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    onClear?.();
  }, [disabled, isSending, isLocalSending, handleChange, onClear]);

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
      <div className={styles.editorArea}>
        <div className={styles.textAreaWrapper}>
          <textarea
            ref={textareaRef}
            value={internalValue}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            disabled={effectiveDisabled}
            placeholder={placeholder}
            maxLength={5000}
            rows={1}
            className={styles.textArea}
          />

          <div className={styles.actionButtons}>
            <GlassButton
              variant="ghost"
              size="sm"
              onPress={handleClear}
              isDisabled={effectiveDisabled}
              className={styles.clearButton}
            >
              清空
            </GlassButton>
            <GlassButton
              variant="primary"
              size="sm"
              loading={isSending || isLocalSending}
              isDisabled={effectiveDisabled}
              onPress={() => { void handleSubmit(); }}
              className={styles.sendButton}
            >
              {submitText}
            </GlassButton>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Composer;
