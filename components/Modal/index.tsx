import React, { useState } from 'react';
import { Popup } from 'antd-mobile';
import CloseIcon from '@/public/icons/close.svg';
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
 * 通用模态框组件，支持头部额外内容与关闭按钮。
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
    if (onClose) {
      onClose();
    }
  };
  const shouldRenderHeader = Boolean(title || showCloseButton || headerExtra);

  return (
    <Popup
      visible={isShow}
      onClose={handleClose}
      onMaskClick={handleClose}
      position="bottom"
      destroyOnClose
      className={styles.modalPopup}
      bodyClassName={styles.modalBody}
      maskStyle={{
        backgroundColor: 'color-mix(in srgb, var(--background) 40%, transparent)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
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
              >
                <CloseIcon />
              </button>
            )}
          </div>
        )}
        <div className={styles.modalBodyContent}>{children}</div>
      </div>
    </Popup>
  );
};

export default Modal;
