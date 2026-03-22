'use client';

import React, { useEffect, forwardRef, useImperativeHandle, useMemo } from 'react';
import Modal, { useModal } from '@/components/Modal';
import { Play, Trash2 } from 'lucide-react';
import {
  usePromptHistoryStore,
  selectSortMode,
  selectIsInitialized,
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
  const hydrateHistory = usePromptHistoryStore((state) => state.hydrate);
  const removeHistoryRecord = usePromptHistoryStore((state) => state.remove);
  const setSortMode = usePromptHistoryStore((state) => state.setSortMode);
  const isHistoryInitialized = usePromptHistoryStore(selectIsInitialized);

  const historyRecords = useMemo(
    () => sortHistoryRecords(Object.values(recordsMap), sortMode),
    [recordsMap, sortMode]
  );

  useEffect(() => {
    if (isShow && !isHistoryInitialized) {
      hydrateHistory();
    }
  }, [hydrateHistory, isHistoryInitialized, isShow]);

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

  const handlePlayButtonClick = (prompt: string) => {
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
                    className={styles.playButton}
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePlayButtonClick(record.prompt);
                    }}
                    aria-label="播放此提示词"
                  >
                    <Play size={16} strokeWidth={2} />
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
