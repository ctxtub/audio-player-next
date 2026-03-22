'use client';

import { createRoot, type Root } from 'react-dom/client';
import React, { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';

/**
 * Toast 配置项。
 */
type ToastConfig = {
  /** 图标类型，成功或失败。 */
  icon?: 'success' | 'fail';
  /** 提示文案。 */
  content: string;
  /** 显示时长（毫秒），默认 2000。 */
  duration?: number;
};

/** Toast 容器 DOM 节点引用。 */
let containerEl: HTMLDivElement | null = null;
/** React Root 实例。 */
let root: Root | null = null;
/** 自动隐藏定时器。 */
let hideTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Toast 图标映射，使用 lucide-react 图标。
 */
const iconMap = {
  success: { Component: CheckCircle2, color: 'var(--status-success)' },
  fail: { Component: XCircle, color: 'var(--status-error)' },
} as const;

/**
 * Toast 内部渲染组件。
 */
const ToastContent: React.FC<ToastConfig & { onDone: () => void }> = ({
  icon,
  content,
  duration = 2000,
  onDone,
}) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    /** 使用 requestAnimationFrame 确保入场动画生效。 */
    requestAnimationFrame(() => setVisible(true));

    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onDone, 250);
    }, duration);

    return () => clearTimeout(timer);
  }, [duration, onDone]);

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 'var(--z-max, 9999)' as unknown as number,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '12px 20px',
          borderRadius: 'var(--radius-lg, 16px)',
          background: 'var(--glass-bg, rgba(38,38,40,0.50))',
          backdropFilter: 'var(--glass-blur, blur(48px) saturate(180%))',
          WebkitBackdropFilter: 'var(--glass-blur, blur(48px) saturate(180%))',
          border: '0.5px solid var(--glass-border, rgba(255,255,255,0.12))',
          boxShadow: 'var(--shadow-lg, 0 8px 32px rgba(0,0,0,0.24))',
          color: 'var(--text-primary, #fff)',
          fontSize: 'var(--text-sm, 14px)',
          lineHeight: 'var(--leading-sm, 1.4)',
          maxWidth: '80vw',
          opacity: visible ? 1 : 0,
          transform: visible ? 'scale(1) translateY(0)' : 'scale(0.9) translateY(8px)',
          transition: 'opacity 0.25s ease, transform 0.25s ease',
          pointerEvents: 'auto',
        }}
      >
        {icon && (() => { const { Component, color } = iconMap[icon]; return <Component size={20} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />; })()}
        <span>{content}</span>
      </div>
    </div>
  );
};

/**
 * 确保 Toast 容器 DOM 存在。
 */
const ensureContainer = () => {
  if (!containerEl) {
    containerEl = document.createElement('div');
    containerEl.id = 'glass-toast-container';
    document.body.appendChild(containerEl);
    root = createRoot(containerEl);
  }
};

/**
 * 卸载 Toast 内容。
 */
const unmount = () => {
  if (root) {
    root.render(null);
  }
};

/**
 * 命令式 Toast 工具，API 兼容 antd-mobile Toast。
 * 用法：GlassToast.show({ icon: 'fail', content: '操作失败', duration: 3000 })
 */
const GlassToast = {
  /**
   * 显示 Toast 提示。
   * @param config Toast 配置
   */
  show(config: ToastConfig) {
    if (typeof window === 'undefined') return;

    ensureContainer();

    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }

    root?.render(<ToastContent {...config} onDone={unmount} />);
  },

  /**
   * 手动关闭 Toast。
   */
  clear() {
    unmount();
  },
};

export default GlassToast;
