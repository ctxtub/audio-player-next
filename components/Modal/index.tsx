import React, { useEffect, useState, useRef } from 'react';
import ReactDOM from 'react-dom';
import { CSSTransition } from 'react-transition-group';
import CloseIcon from '@/public/icons/close.svg';
import styles from './index.module.scss';

export interface ModalProps {
  isShow: boolean;
  title?: string;
  showCloseButton?: boolean;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
  onClose?: () => void;
}

export interface ModalInstance {
  show: () => void;
  close: () => void;
  destroy: () => void;
  update: (newProps: Partial<ModalProps>) => void;
}

export const useModal = () => {
  const [isShow, setIsShow] = useState(false);
  const showModal = () => setIsShow(true);
  const closeModal = () => setIsShow(false);
  return { isShow, showModal, closeModal };
};

const Modal: React.FC<ModalProps> = ({
  isShow,
  title,
  showCloseButton = true,
  headerExtra,
  children,
  onClose,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isShow) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [isShow]);

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  const handleClose = () => {
    if (onClose) {
      onClose();
    }
  };

  const handleEntered = () => {
    // 动画进入完成后的回调
  };

  const handleExited = () => {
    // 动画退出完成后的回调
  };

  return ReactDOM.createPortal(
    <CSSTransition
      in={isShow}
      timeout={{ enter: 350, exit: 250 }}
      classNames={{
        enter: styles.modalEnter,
        enterActive: styles.modalEnterActive,
        exit: styles.modalExit,
        exitActive: styles.modalExitActive,
      }}
      unmountOnExit
      mountOnEnter
      nodeRef={overlayRef}
      onEntered={handleEntered}
      onExited={handleExited}
    >
      <div 
        ref={overlayRef}
        className={styles.modalOverlay}
        onClick={handleOverlayClick}
      >
        <div 
          ref={contentRef}
          className={styles.modalContent}
          onClick={(e) => e.stopPropagation()}
        >
          {(title || showCloseButton || headerExtra) && (
            <div className={styles.modalHeader}>
              <div className={styles.modalTitle}>
                {title}
                {headerExtra && (
                  <div className={styles.headerExtra}>
                    {headerExtra}
                  </div>
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
          {children}
        </div>
      </div>
    </CSSTransition>,
    document.body
  );
};

export default Modal;
