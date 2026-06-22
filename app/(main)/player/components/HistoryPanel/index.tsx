'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import HistoryRecords from '@/app/(main)/player/components/HistoryRecords';
import GenerationHistory from '@/app/(main)/player/components/GenerationHistory';
import { useChatStore } from '@/stores/chatStore';
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
 * 播放器页历史面板：在播放器下方平铺承载「提示词历史 / 生成历史」两个内联列表，
 * 用分段控件切换。头部右侧仅在提示词页展示排序切换；选择提示词跳创作页预填并自动发送。
 * @returns 历史面板 JSX
 */
const HistoryPanel: React.FC = () => {
  /** 路由：选择提示词后跳转创作页。 */
  const router = useRouter();
  /** 当前激活分段，默认提示词历史（访客与登录都有内容）。 */
  const [activeTab, setActiveTab] = useState<HistoryTab>('prompt');
  /** 设置跨页待发提示词。 */
  const setPendingAutoSend = useChatStore((state) => state.setPendingAutoSend);
  /** 提示词排序模式：频率 / 时间。 */
  const sortMode = usePromptHistoryStore(selectSortMode);
  /** 切换提示词排序模式。 */
  const setSortMode = usePromptHistoryStore((state) => state.setSortMode);

  /** 切换提示词排序模式（频率 ⇄ 时间）。 */
  const toggleSortMode = () => {
    setSortMode(sortMode === 'frequency' ? 'recent' : 'frequency');
  };

  /** 选择历史提示词：预填并跳转创作页自动发送（重新创作，非本页播放）。 */
  const handleSelectPrompt = (prompt: string) => {
    setPendingAutoSend(prompt);
    router.push('/chat');
  };

  return (
    <section className={styles.panel}>
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

        {activeTab === 'prompt' && (
          <button className={styles.sortButton} onClick={toggleSortMode}>
            {sortMode === 'frequency' ? '按频率排序' : '按时间排序'}
          </button>
        )}
      </div>

      <div className={styles.body}>
        {activeTab === 'prompt' ? (
          <HistoryRecords onSelectPrompt={handleSelectPrompt} />
        ) : (
          <GenerationHistory />
        )}
      </div>
    </section>
  );
};

export default HistoryPanel;
