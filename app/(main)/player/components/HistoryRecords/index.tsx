'use client';

import React, { forwardRef, useImperativeHandle, useMemo } from 'react';
import Modal, { useModal } from '@/components/Modal';
import { Wand2, Trash2 } from 'lucide-react';
import {
  usePromptHistoryStore,
  selectSortMode,
  sortHistoryRecords,
} from '@/stores/promptHistoryStore';
import styles from './index.module.scss';

export type { HistoryRecord } from '@/stores/promptHistoryStore';

/**
 * 暴露给父组件的历史记录弹窗控制方法。
 */
export interface HistoryRecordsRef {
  showModal: () => void;
}

/**
 * 历史记录组件的入参定义。
 */
interface HistoryRecordsProps {
  onSelectPrompt: (prompt: string) => void;
}

/**
 * 历史记录弹窗组件，支持提示词排序与回放。
 */
const HistoryRecords = forwardRef<HistoryRecordsRef, HistoryRecordsProps>((props, ref) => {
  const { onSelectPrompt } = props;
  const { isShow, showModal, closeModal } = useModal();
  const recordsMap = usePromptHistoryStore((state) => state.recordsMap);
  const sortMode = usePromptHistoryStore(selectSortMode);
  const removeHistoryRecord = usePromptHistoryStore((state) => state.remove);
  const setSortMode = usePromptHistoryStore((state) => state.setSortMode);

  const historyRecords = useMemo(
    () => sortHistoryRecords(Object.values(recordsMap), sortMode),
    [recordsMap, sortMode]
  );

  const toggleSortMethod = () => {
    const nextMode = sortMode === 'frequency' ? 'recent' : 'frequency';
    setSortMode(nextMode);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleSelectPrompt = (prompt: string) => {
    onSelectPrompt(prompt);
  };

  // 选择历史提示词：关闭弹窗后交给上层跳转创作页预填并自动发送（重新创作，非播放）。
  const handleRegenerateClick = (prompt: string) => {
    closeModal();
    setTimeout(() => {
      handleSelectPrompt(prompt);
    }, 100);
  };

  const renderSortButton = () => {
    return (
      <button onClick={toggleSortMethod} className={styles.sortButton}>
        {sortMode === 'frequency' ? '按频率排序' : '按时间排序'}
      </button>
    );
  };

  const renderHistoryContent = () => {
    return (
      <>
        {historyRecords.length > 0 ? (
          <div className={styles.historyList}>
            {historyRecords.map((record, index) => (
              <div key={index} className={styles.historyItem}>
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
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRegenerateClick(record.prompt);
                    }}
                    aria-label="用此提示词重新创作"
                    title="用此提示词重新创作"
                  >
                    <Wand2 size={16} strokeWidth={2} />
                  </button>
                  <button
                    className={styles.deleteButton}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeHistoryRecord(record.prompt);
                    }}
                    aria-label="删除此提示词"
                  >
                    <Trash2 size={16} strokeWidth={1.8} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.emptyHistory}>
            <p>暂无历史记录</p>
            <p className={styles.emptyHistoryHint}>生成故事后，您的提示词将会显示在这里</p>
          </div>
        )}
      </>
    );
  };

  useImperativeHandle(ref, () => ({
    showModal,
  }));

  return (
    <Modal
      isShow={isShow}
      title="历史提示词记录"
      headerExtra={renderSortButton()}
      onClose={closeModal}
    >
      {renderHistoryContent()}
    </Modal>
  );
});

HistoryRecords.displayName = 'HistoryRecords';

export default HistoryRecords;
