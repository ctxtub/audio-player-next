'use client';

import React, { useEffect, forwardRef, useImperativeHandle, useMemo } from 'react';
import Modal, { useModal } from '@/components/Modal';
import PlayIcon from '@/public/icons/audioplayer-play.svg';
import DeleteIcon from '@/public/icons/close.svg';
import {
  usePromptHistoryStore,
  selectSortMode,
  selectIsInitialized,
  sortHistoryRecords,
} from '@/stores/promptHistoryStore';

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
      <button
        onClick={toggleSortMethod}
        className="rounded-[15px] border-0 bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] px-[10px] py-[5px] text-sm text-[var(--process)] transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)] hover:-translate-y-px"
      >
        {sortMode === 'frequency' ? '按频率排序' : '按时间排序'}
      </button>
    );
  };

  const renderHistoryContent = () => {
    return (
      <>
        {historyRecords.length > 0 ? (
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-5">
            {historyRecords.map((record, index) => (
              <div
                key={index}
                className="flex items-center gap-3 rounded-[12px] border border-[var(--card-border)] bg-[color-mix(in_srgb,var(--card-background)_80%,transparent)] px-4 py-4 transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)] hover:-translate-y-[2px] hover:bg-[color-mix(in_srgb,var(--primary)_5%,transparent)] hover:shadow-[0_4px_12px_var(--shadow-color)] backdrop-blur-[5px]"
              >
                <div className="mr-3 flex h-[30px] min-w-[30px] items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--primary)_15%,transparent)] font-semibold text-[var(--foreground)]">
                  {index + 1}
                </div>
                <div className="mr-[10px] flex-1">
                  <div className="mb-2 break-words text-[16px] leading-[1.5] text-[var(--foreground)]">{record.prompt}</div>
                  <div className="flex gap-2 text-xs text-[var(--secondary)]">
                    <span>最后使用: {formatDate(record.lastUsed)}</span>
                    <span>使用次数: {record.useCount}</span>
                  </div>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <button
                    className="flex h-10 w-10 items-center justify-center rounded-full border-0 bg-[var(--primary)] text-white shadow-[0_4px_12px_color-mix(in_srgb,var(--primary)_50%,transparent)] transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)] hover:scale-110"
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePlayButtonClick(record.prompt);
                    }}
                    aria-label="播放此提示词"
                  >
                    <PlayIcon className="h-5 w-5 stroke-white" />
                  </button>
                  <button
                    className="flex h-10 w-10 items-center justify-center rounded-full border-0 bg-[var(--error)] text-white shadow-[0_4px_12px_color-mix(in_srgb,var(--error)_50%,transparent)] transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)] hover:scale-110"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeHistoryRecord(record.prompt);
                    }}
                    aria-label="删除此提示词"
                  >
                    <DeleteIcon className="h-[22px] w-[22px] stroke-white" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="m-auto space-y-2 px-5 py-10 text-center text-[var(--secondary)]">
            <p>暂无历史记录</p>
            <p className="text-sm opacity-70">生成故事后，您的提示词将会显示在这里</p>
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
