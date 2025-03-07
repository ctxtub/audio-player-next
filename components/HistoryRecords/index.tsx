import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import PlayIcon from '@/public/icons/audioplayer-play.svg';
import DeleteIcon from '@/public/icons/close.svg';
import Modal, { useModal } from '../Modal';
import styles from './index.module.scss';

export interface HistoryRecord {
  prompt: string;
  lastUsed: string;
  useCount: number;
}

export interface HistoryRecordsRef {
  showModal: () => void;
}

interface HistoryRecordsProps {
  onSelectPrompt: (prompt: string) => void;
}

const HistoryRecords = forwardRef<HistoryRecordsRef, HistoryRecordsProps>((props, ref) => {
  const { onSelectPrompt } = props;
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>([]);
  const [sortByFrequency, setSortByFrequency] = useState(true);
  const { isShow, showModal, closeModal } = useModal();

  useEffect(() => {
    if (isShow) {
      loadHistoryRecords();
    }
  }, [isShow]);

  const loadHistoryRecords = () => {
    try {
      const historyData = localStorage.getItem('promptHistory');
      if (historyData) {
        const parsedHistory: Record<string, HistoryRecord> = JSON.parse(historyData);
        
        // 转换为数组并过滤掉30天以前的记录
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        const historyArray = Object.values(parsedHistory).filter(record => {
          const lastUsedDate = new Date(record.lastUsed);
          return lastUsedDate >= thirtyDaysAgo;
        });
        
        // 根据排序方式排序
        const sortedHistory = sortHistoryRecords(historyArray, sortByFrequency);
        setHistoryRecords(sortedHistory);
      }
    } catch (error) {
      console.error('Failed to load history records:', error);
      setHistoryRecords([]);
      localStorage.removeItem('promptHistory');
    }
  };

  const deleteHistoryRecord = (prompt: string) => {
    try {
      const historyData = localStorage.getItem('promptHistory');
      if (historyData) {
        const parsedHistory: Record<string, HistoryRecord> = JSON.parse(historyData);
        
        // 删除指定提示词的记录
        if (parsedHistory[prompt]) {
          delete parsedHistory[prompt];
          localStorage.setItem('promptHistory', JSON.stringify(parsedHistory));
          
          // 更新状态
          setHistoryRecords(prevRecords => 
            prevRecords.filter(record => record.prompt !== prompt)
          );
        }
      }
    } catch (error) {
      console.error('Failed to delete history record:', error);
    }
  };

  const sortHistoryRecords = (records: HistoryRecord[], byFrequency: boolean) => {
    return [...records].sort((a, b) => {
      if (byFrequency) {
        // 按使用频率排序（从高到低）
        return b.useCount - a.useCount;
      } else {
        // 按最近使用时间排序（从新到旧）
        return new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime();
      }
    });
  };

  const toggleSortMethod = () => {
    setSortByFrequency(!sortByFrequency);
    setHistoryRecords(sortHistoryRecords(historyRecords, !sortByFrequency));
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('zh-CN', { 
      month: 'numeric', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const handleSelectPrompt = (prompt: string) => {
    onSelectPrompt(prompt);
  };

  // 处理播放按钮点击，先关闭弹窗再选择提示词
  const handlePlayButtonClick = (prompt: string) => {
    // 直接调用父组件的关闭函数
    closeModal();
    // 然后选择提示词
    setTimeout(() => {
      handleSelectPrompt(prompt);
    }, 100);
  };

  // 渲染排序按钮作为标题栏的额外内容
  const renderSortButton = () => {
    return (
      <button 
        onClick={toggleSortMethod}
        className={styles.sortButton}
      >
        {sortByFrequency ? '按频率排序' : '按时间排序'}
      </button>
    );
  };

  const renderHistoryContent = () => {
    return (
      <>
        {historyRecords.length > 0 ? (
          <div className={styles.historyList}>
            {historyRecords.map((record, index) => (
              <div 
                key={index} 
                className={styles.historyItem}
              >
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
                    <PlayIcon />
                  </button>
                  <button 
                    className={styles.deleteButton}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteHistoryRecord(record.prompt);
                    }}
                    aria-label="删除此提示词"
                  >
                    <DeleteIcon />
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

export default HistoryRecords;
