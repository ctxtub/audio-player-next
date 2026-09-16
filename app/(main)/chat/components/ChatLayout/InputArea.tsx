import React from 'react';
import Composer from '../Composer/Composer';
import type { ComposerProps } from '../Composer/Composer';
import styles from './index.module.scss';

/**
 * 输入区域组件的属性定义，复用 Composer 的核心控制字段与左侧扩展插槽。
 */
type InputAreaProps = Pick<
  ComposerProps,
  'onSubmit' | 'disabled' | 'isSending' | 'value' | 'onChange' | 'onClear' | 'leftSlot' | 'clearText'
>;

/**
 * 聊天输入区域，占位承载消息输入与发送控制；leftSlot 透传给 Composer。
 * @returns 输入区域结构 JSX。
 */
const InputArea: React.FC<InputAreaProps> = ({
  onSubmit,
  disabled,
  isSending,
  value,
  onChange,
  onClear,
  leftSlot,
  clearText,
}) => {
  return (
    <div className={styles.inputArea}>
      <div className={styles.inputContent}>
        <Composer
          onSubmit={onSubmit}
          disabled={disabled}
          isSending={isSending}
          value={value}
          onChange={onChange}
          onClear={onClear}
          leftSlot={leftSlot}
          clearText={clearText}
        />
      </div>
    </div>
  );
};

export default InputArea;
