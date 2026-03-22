'use client';

import React, { useState } from 'react';
import {
  Dialog,
  DialogTrigger,
  Modal as AriaModal,
  ModalOverlay,
} from 'react-aria-components';
import { X } from 'lucide-react';
import styles from './index.module.scss';

/**
 * 模态框组件的入参。
 */
export interface ModalProps {
  isShow: boolean;
  title?: string;
  showCloseButton?: boolean;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
  onClose?: () => void;
}

/**
 * 控制模态框显隐的 Hook。
 * @returns 模态框可见状态及开关方法
 */
export const useModal = () => {
  const [isShow, setIsShow] = useState(false);
  const showModal = () => setIsShow(true);
  const closeModal = () => setIsShow(false);
  return { isShow, showModal, closeModal };
};

/**
 * 通用底部弹出模态框组件，支持头部额外内容与关闭按钮。
 * 使用 React Aria Dialog 替代 antd-mobile Popup，支持完整的无障碍交互。
 */
const Modal: React.FC<ModalProps> = ({
  isShow,
  title,
  showCloseButton = true,
  headerExtra,
  children,
  onClose,
}) => {
  const handleClose = () => {
    onClose?.();
  };

  const shouldRenderHeader = Boolean(title || showCloseButton || headerExtra);

  return (
    <DialogTrigger isOpen={isShow} onOpenChange={(open) => { if (!open) handleClose(); }}>
      <ModalOverlay className={styles.overlay} isDismissable>
        <AriaModal className={styles.modalContainer}>
          <Dialog className={styles.dialog} aria-label={title ?? '弹窗'}>
            <div className={styles.modalContent}>
              {shouldRenderHeader && (
                <div className={styles.modalHeader}>
                  <div className={styles.modalTitle}>
                    {title}
                    {headerExtra && (
                      <div className={styles.headerExtra}>{headerExtra}</div>
                    )}
                  </div>
                  {showCloseButton && (
                    <button
                      className={styles.closeButton}
                      onClick={handleClose}
                      aria-label="关闭"
                      type="button"
                    >
                      <X size={20} strokeWidth={1.8} />
                    </button>
                  )}
                </div>
              )}
              <div className={styles.modalBodyContent}>{children}</div>
            </div>
          </Dialog>
        </AriaModal>
      </ModalOverlay>
    </DialogTrigger>
  );
};

export default Modal;
