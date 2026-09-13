'use client';

import React, { useState } from 'react';
import HistoryRecords from '@/app/(main)/chat/components/HistoryRecords';
import GenerationHistory from '@/app/(main)/chat/components/GenerationHistory';
import { usePromptHistoryStore, selectSortMode } from '@/stores/promptHistoryStore';
import styles from './index.module.scss';

/** 历史面板可切换的两个分段。 */
type HistoryTab = 'prompt' | 'generation';

/** 分段定义：key 与展示文案。 */
const TABS: ReadonlyArray<{ key: HistoryTab; label: string }> = [
  { key: 'prompt', label: '提示词历史' },
  { key: 'generation', label: '生成历史' },
];

/**
 * Chat 所有的 History Surface 受控展示组件的入参定义（M4-07）。
 */
export interface HistoryPanelProps {
  /** 选择某条提示词「重新创作」时回调，由 ChatLayout 适配器消费（setPendingAutoSend + 关面板）。 */
  onSelectPrompt: (prompt: string) => void;
  /** 关闭 History Surface 回调，由 ChatLayout 持有纯 UI state。 */
  onClose: () => void;
}

/**
 * Chat-owned History Surface：承载「提示词历史 / 生成历史」两个内联列表，用分段控件切换。
 * 纯 presentation ownership：只拥有 activeTab 与排序模式 UI；不拥有 router、跨页导航、
 * pendingAutoSend 编排、generation 编排与 Chat reset（M4-07 relocation 非 migration）。
 * 数据源保持不变：提示词经 HistoryRecords 读 promptHistoryStore，生成经 GenerationHistory 读 generationHistoryStore。
 * @param props.onSelectPrompt 选择提示词回调（重新创作，同页消费）
 * @param props.onClose 关闭入口回调
 * @returns 历史面板 JSX
 */
const HistoryPanel: React.FC<HistoryPanelProps> = ({ onSelectPrompt, onClose }) => {
  /** 当前激活分段，默认提示词历史（访客与登录都有内容）。 */
  const [activeTab, setActiveTab] = useState<HistoryTab>('prompt');
  /** 提示词排序模式：频率 / 时间。 */
  const sortMode = usePromptHistoryStore(selectSortMode);
  /** 切换提示词排序模式。 */
  const setSortMode = usePromptHistoryStore((state) => state.setSortMode);

  /** 切换提示词排序模式（频率 ⇄ 时间）。 */
  const toggleSortMode = () => {
    setSortMode(sortMode === 'frequency' ? 'recent' : 'frequency');
  };

  return (
    <section className={styles.panel} aria-label="历史">
      <div className={styles.header}>
        <div className={styles.segmented} role="tablist" aria-label="历史类型切换">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              type="button"
              aria-selected={activeTab === tab.key}
              className={`${styles.segment} ${activeTab === tab.key ? styles.segmentActive : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className={styles.headerActions}>
          {activeTab === 'prompt' && (
            <button type="button" className={styles.sortButton} onClick={toggleSortMode}>
              {sortMode === 'frequency' ? '按频率排序' : '按时间排序'}
            </button>
          )}
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="关闭历史">
            关闭
          </button>
        </div>
      </div>

      <div className={styles.body}>
        {activeTab === 'prompt' ? (
          <HistoryRecords onSelectPrompt={onSelectPrompt} />
        ) : (
          <GenerationHistory />
        )}
      </div>
    </section>
  );
};

export default HistoryPanel;
