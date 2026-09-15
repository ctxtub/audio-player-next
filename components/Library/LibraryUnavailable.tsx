'use client';

import React from 'react';
import Link from 'next/link';
import { FileQuestion, ArrowLeft } from 'lucide-react';
import styles from './libraryUnavailable.module.scss';

export interface LibraryUnavailableProps {
  title?: string;
  message?: string;
  backHref?: string;
}

/**
 * 判定错误是否属于统一不可用语义（NOT_FOUND / UNAUTHORIZED / foreign / trashed / missing）
 *
 * 规范要求：
 * NOT_FOUND / UNAUTHORIZED / foreign-owned work / trashed work / 不存在的 work ——
 * 客户端展示完全相同，保持 M2 刻意设计的不可区分性，彻底杜绝侧信道探测。
 */
export function isUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const errObj = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
    shape?: { code?: unknown };
    data?: { code?: unknown; httpStatus?: unknown };
  };
  const code = errObj.data?.code ?? errObj.shape?.code ?? errObj.code;
  const httpStatus = errObj.data?.httpStatus ?? errObj.status ?? errObj.statusCode;
  const message = String(errObj.message ?? '');

  // 1. 优先根据结构化错误字段判定（tRPC TRPCClientError / TRPCError 核心主路径）
  if (code === 'NOT_FOUND' || code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
    return true;
  }
  if (httpStatus === 404 || httpStatus === 401 || httpStatus === 403) {
    return true;
  }

  // 2. 文本消息回退匹配（仅用于边缘网关或非标准异常无结构化响应时的防御兜底）
  // 安全收窄：使用独立词界匹配 /\b(404|401|403)\b/，杜绝将端口号（如 31404）或无辜数字 ID 串误判为不可用
  if (
    message.includes('NOT_FOUND') ||
    message.includes('UNAUTHORIZED') ||
    message.includes('FORBIDDEN') ||
    message.includes('作品不存在') ||
    /\b(404|401|403)\b/.test(message)
  ) {
    return true;
  }
  return false;
}

/**
 * 故事库统一不可用状态展示组件（M3-06）
 *
 * 核心安全与隐私原则：
 * 针对 NOT_FOUND、UNAUTHORIZED、跨主体 (foreign-owned)、回收站中 (trashed) 以及不存在的作品，
 * 客户端严格渲染完全相同且不可区分的统一不可用界面，防止外部通过错误形态探测作品存在性或归属。
 */
export const LibraryUnavailable: React.FC<LibraryUnavailableProps> = ({
  title = '故事未找到或不可访问',
  message = '该故事可能不存在、已被移入回收站，或者您没有访问该作品的权限。',
  backHref = '/library',
}) => {
  return (
    <div
      className={styles.unavailableContainer}
      data-testid="library-unavailable"
      role="status"
    >
      <div className={styles.iconWrapper} data-testid="library-unavailable-icon">
        <FileQuestion size={36} />
      </div>
      <h2 className={styles.title} data-testid="library-unavailable-title">
        {title}
      </h2>
      <p className={styles.message} data-testid="library-unavailable-message">
        {message}
      </p>
      <Link
        href={backHref}
        className={styles.backButton}
        data-testid="back-to-library-link"
      >
        <ArrowLeft size={16} />
        <span>返回故事库</span>
      </Link>
    </div>
  );
};

export default LibraryUnavailable;
