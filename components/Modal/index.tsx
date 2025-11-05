import React, { useState } from "react";
import { Popup } from "antd-mobile";
import CloseIcon from "@/public/icons/close.svg";

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
      bodyClassName="mx-auto flex h-[80vh] w-full max-w-[var(--size-max-width-modal)] flex-col overflow-hidden rounded-t-modal border border-border-card bg-surface-overlay px-0 py-0 shadow-surface-top backdrop-blur-panel"
      maskStyle={{
        backgroundColor:
          "color-mix(in srgb, var(--background) 40%, transparent)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
    >
        <div className="flex h-full flex-col overflow-hidden">
          {shouldRenderHeader && (
            <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-surface px-5 pb-md pt-5 text-foreground shadow-surface-inner backdrop-blur-soft">
              <div className="flex items-center gap-sm text-lg font-semibold">
                {title}
                {headerExtra && (
                <div className="flex items-center">{headerExtra}</div>
              )}
            </div>
            {showCloseButton && (
              <button
                className="flex h-10 w-10 items-center justify-center rounded-full border border-border-card bg-surface text-primary shadow-surface-sm backdrop-blur-soft transition-transform duration-theme ease-theme hover:scale-105 hover:shadow-surface-md"
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
