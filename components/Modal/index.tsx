import React, { useState } from 'react';
import { Popup } from 'antd-mobile';
import CloseIcon from '@/public/icons/close.svg';

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
      className="flex justify-center"
      bodyClassName="mx-auto flex h-[80vh] w-full max-w-[800px] flex-col overflow-hidden rounded-t-[20px] border border-[var(--card-border)] bg-[color-mix(in_srgb,var(--background)_90%,transparent)] px-0 py-0 shadow-[0_-5px_20px_var(--shadow-color)] backdrop-blur-[var(--blur-radius)]"
      maskStyle={{
        backgroundColor: 'color-mix(in srgb, var(--background) 40%, transparent)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      <div className="flex h-full flex-col overflow-hidden">
        {shouldRenderHeader && (
          <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-[var(--card-background)] px-5 pb-[15px] pt-5 shadow-[0_2px_10px_color-mix(in_srgb,var(--shadow-color)_30%,transparent)] backdrop-blur-[var(--blur-radius)]">
            <div className="flex items-center gap-[10px] text-[18px] font-semibold text-[var(--foreground)]">
              {title}
              {headerExtra && (
                <div className="flex items-center">{headerExtra}</div>
              )}
            </div>
            {showCloseButton && (
              <button
                className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--card-border)] bg-[var(--card-background)] text-[var(--primary)] shadow-[0_2px_8px_var(--shadow-color)] transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)] backdrop-blur-[5px] hover:scale-[1.05] hover:shadow-[0_4px_12px_var(--shadow-color)]"
                onClick={handleClose}
                aria-label="关闭"
              >
                <CloseIcon />
              </button>
            )}
          </div>
        )}
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </Popup>
  );
};

export default Modal;
