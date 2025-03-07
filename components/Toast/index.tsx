'use client';

import React, { useEffect, useState, FC, ReactNode, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { CSSTransition } from 'react-transition-group';
import styles from './index.module.scss';

interface ToastOptions {
  message: string;
  type?: 'error' | 'success' | 'info';
  duration?: number;
  onClose?: () => void;
}

interface ToastProps extends ToastOptions {
  id: string;
  onRemove: (id: string) => void;
}

// 获取图标
const getIcon = (type: 'error' | 'success' | 'info'): ReactNode => {
  switch(type) {
    case 'success':
      return '✓';
    case 'error':
      return '✕';
    case 'info':
      return 'ℹ';
    default:
      return '';
  }
};

// 单个Toast组件
const ToastItem: FC<ToastProps> = ({ id, message, type = 'error', duration = 3000, onClose, onRemove }) => {
  const [isVisible, setIsVisible] = useState(false);
  const toastRef = React.useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    // 立即显示Toast以触发进入动画
    setIsVisible(true);
    
    // 设置自动隐藏的定时器
    const hideTimer = setTimeout(() => {
      setIsVisible(false);
    }, duration);
    
    // 清理函数
    return () => {
      clearTimeout(hideTimer);
    };
  }, [duration]);

  const handleExited = () => {
    if (onClose) onClose();
    onRemove(id);
  };
  
  return (
    <CSSTransition
      in={isVisible}
      timeout={300}
      classNames={{
        enter: styles.toastEnter,
        enterActive: styles.toastEnterActive,
        exit: styles.toastExit,
        exitActive: styles.toastExitActive,
      }}
      unmountOnExit
      nodeRef={toastRef}
      onExited={handleExited}
    >
      <div ref={toastRef} className={`${styles.toast} ${styles[type]}`}>
        <div className={styles.content}>
          <div className={styles.icon}>{getIcon(type)}</div>
          <div className={styles.message}>{message}</div>
        </div>
      </div>
    </CSSTransition>
  );
};

// 存储在Toast容器初始化前的待处理Toast队列
let pendingToasts: ToastOptions[] = [];

// Toast容器组件
const ToastContainer: FC = () => {
  const [toasts, setToasts] = useState<Array<ToastProps & { id: string }>>([]);
  
  // 移除指定id的toast
  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  };
  
  // 添加新的toast
  const addToast = useCallback((options: ToastOptions) => {
    const id = Date.now().toString();
    setToasts(prev => [...prev, { ...options, id, onRemove: removeToast }]);
    
    // 返回手动关闭函数
    return () => removeToast(id);
  },[]);
  
  // 全局暴露添加toast的方法
  useEffect(() => {
    (window as any).__addToast = addToast;
    
    // 处理待处理的Toast队列
    if (pendingToasts.length > 0) {
      pendingToasts.forEach(options => {
        addToast(options);
      });
      pendingToasts = [];
    }
    
    return () => {
      delete (window as any).__addToast;
    };
  }, [addToast]);
  
  return (
    <div className={styles.container}>
      {toasts.map(toast => (
        <ToastItem key={toast.id} {...toast} />
      ))}
    </div>
  );
};

// 创建一个DOM节点来挂载Toast容器
let toastRoot: HTMLDivElement | null = null;

// 确保只创建一次容器
const ensureToastRoot = () => {
  if (!toastRoot) {
    toastRoot = document.createElement('div');
    toastRoot.id = 'toast-root';
    document.body.appendChild(toastRoot);
    createRoot(toastRoot).render(<ToastContainer />);
  }
  return toastRoot;
};

// 显示Toast的函数
export const Toast = (options: ToastOptions) => {
  // 确保Toast容器已创建
  ensureToastRoot();
  
  // 获取全局暴露的添加toast方法
  const addToast = (window as any).__addToast;
  if (!addToast) {
    console.log('Toast container not initialized yet, queuing toast');
    // 将Toast添加到待处理队列
    pendingToasts.push(options);
    return () => {};
  }
  
  // 添加新的toast并返回关闭函数
  return addToast(options);
};