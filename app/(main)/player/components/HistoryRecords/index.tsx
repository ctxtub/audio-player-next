'use client';

import React, { useMemo } from 'react';
import { Wand2, Trash2 } from 'lucide-react';
import {
  usePromptHistoryStore,
  selectSortMode,
  sortHistoryRecords,
} from '@/stores/promptHistoryStore';
import styles from './index.module.scss';

/**
 * 提示词历史列表组件的入参定义。
 */
interface HistoryRecordsProps {
  /** 选择某条提示词「重新创作」时回调，交由上层跳转创作页预填并自动发送。 */
  onSelectPrompt: (prompt: string) => void;
}

/**
 * 提示词历史内联列表：按当前排序模式展示历史提示词，支持「重新创作」与删除。
 * 排序模式的切换入口由父级 HistoryPanel 头部承载；本组件仅按全局排序状态只读渲染。
 * @param props.onSelectPrompt 选择提示词回调（重新创作）
 * @returns 提示词历史列表 JSX
 */
const HistoryRecords: React.FC<HistoryRecordsProps> = ({ onSelectPrompt }) => {
  /** 提示词记录表（账号维度同步）。 */
  const recordsMap = usePromptHistoryStore((state) => state.recordsMap);
  /** 当前排序模式：频率 / 时间。 */
  const sortMode = usePromptHistoryStore(selectSortMode);
  /** 删除某条提示词记录。 */
  const removeHistoryRecord = usePromptHistoryStore((state) => state.remove);

  /** 按排序模式得到的有序记录列表。 */
  const historyRecords = useMemo(
    () => sortHistoryRecords(Object.values(recordsMap), sortMode),
    [recordsMap, sortMode],
  );

  /**
   * 格式化「最后使用」时间为简短中文日期。
   * @param dateString ISO 时间字符串
   * @returns 形如「6/22 14:30」的本地化文本
   */
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (historyRecords.length === 0) {
    return (
      <div className={styles.emptyHistory}>
        <p>暂无历史记录</p>
        <p className={styles.emptyHistoryHint}>生成故事后，您的提示词将会显示在这里</p>
      </div>
    );
  }

  return (
    <div className={styles.historyList}>
      {historyRecords.map((record, index) => (
        <div key={record.prompt} className={styles.historyItem}>
          <div className={styles.historyIndex}>{index + 1}</div>
          <div className={styles.historyContent}>
            <div className={styles.historyPrompt}>{record.prompt}</div>
            <div className={styles.historyMeta}>
              <span className={styles.historyDate}>最后使用: {formatDate(record.lastUsed)}</span>
              <span className={styles.historyCount}>使用次数: {record.useCount}</span>
            </div>
          </div>
          <div className={styles.actionButtons}>
            <button
              className={styles.regenerateButton}
              onClick={() => onSelectPrompt(record.prompt)}
              aria-label="用此提示词重新创作"
              title="用此提示词重新创作"
            >
              <Wand2 size={16} strokeWidth={2} />
            </button>
            <button
              className={styles.deleteButton}
              onClick={() => removeHistoryRecord(record.prompt)}
              aria-label="删除此提示词"
            >
              <Trash2 size={16} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};

export default HistoryRecords;
