'use client';

import React from 'react';
import { Trash2 } from 'lucide-react';
import styles from './index.module.scss';

/**
 * 历史列表容器：提供滚动与间距，承载若干 HistoryListItem。
 * @param props.children 列表项
 * @returns 列表容器 JSX
 */
export const HistoryList: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className={styles.historyList}>{children}</div>
);

/**
 * 历史列表项的入参定义。提示词历史与生成历史共用同一视觉行，差异通过可选项表达。
 */
interface HistoryListItemProps {
  /** 序号（提示词历史展示；生成历史不传则不渲染徽标）。 */
  index?: number;
  /** 主标题（提示词文本）。 */
  title: string;
  /** 正文摘要（生成历史专有；传入时标题收为单行）。 */
  excerpt?: string;
  /** 元信息行内容（日期、使用次数等，由调用方组合）。 */
  meta: React.ReactNode;
  /** 主操作：重新创作 / 回放。 */
  primaryAction: { icon: React.ReactNode; label: string; onClick: () => void };
  /** 删除回调。 */
  onDelete: () => void;
  /** 删除按钮的无障碍标签。 */
  deleteLabel: string;
}

/**
 * 历史列表项：左侧可选序号、中部标题/摘要/元信息、右侧主操作 + 删除。
 * 删除图标统一为 Trash2；主操作图标由调用方按语义传入（Wand2 / Play）。
 * @returns 列表项 JSX
 */
export const HistoryListItem: React.FC<HistoryListItemProps> = ({
  index,
  title,
  excerpt,
  meta,
  primaryAction,
  onDelete,
  deleteLabel,
}) => (
  <div className={styles.historyItem}>
    {index !== undefined && <div className={styles.historyIndex}>{index}</div>}
    <div className={styles.historyContent}>
      <div
        className={`${styles.historyPrompt} ${excerpt ? styles.historyPromptCompact : ''}`}
      >
        {title}
      </div>
      {excerpt && <div className={styles.historyExcerpt}>{excerpt}</div>}
      <div className={styles.historyMeta}>{meta}</div>
    </div>
    <div className={styles.actionButtons}>
      <button
        type="button"
        className={styles.primaryAction}
        onClick={primaryAction.onClick}
        aria-label={primaryAction.label}
        title={primaryAction.label}
      >
        {primaryAction.icon}
      </button>
      <button type="button" className={styles.deleteButton} onClick={onDelete} aria-label={deleteLabel}>
        <Trash2 size={16} strokeWidth={1.8} />
      </button>
    </div>
  </div>
);

/**
 * 历史空状态：主文案 + 提示文案，居中填充列表区。
 * @param props.title 主文案
 * @param props.hint 提示文案
 * @returns 空状态 JSX
 */
export const HistoryEmpty: React.FC<{ title: string; hint: string }> = ({ title, hint }) => (
  <div className={styles.emptyHistory}>
    <p>{title}</p>
    <p className={styles.emptyHistoryHint}>{hint}</p>
  </div>
);
