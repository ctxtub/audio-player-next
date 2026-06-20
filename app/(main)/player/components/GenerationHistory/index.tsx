'use client';

import React, { forwardRef, useImperativeHandle, useMemo } from 'react';
import { Play, Trash2 } from 'lucide-react';

import Modal, { useModal } from '@/components/Modal';
import GlassToast from '@/components/ui/GlassToast';
import { useGenerationHistoryStore } from '@/stores/generationHistoryStore';
import { useAuthStore } from '@/stores/authStore';
import { replayGeneration } from '@/app/services/storyFlow';
import styles from './index.module.scss';

/**
 * 暴露给父组件的生成历史弹窗控制方法。
 */
export interface GenerationHistoryRef {
  showModal: () => void;
}

/** 故事正文摘要的最大字符数。 */
const EXCERPT_LIMIT = 60;

/**
 * 生成历史弹窗：浏览历史生成的故事，支持回放（重合成）与删除。登录专属。
 */
const GenerationHistory = forwardRef<GenerationHistoryRef>((_props, ref) => {
  const { isShow, showModal, closeModal } = useModal();
  const records = useGenerationHistoryStore((state) => state.records);
  const removeRecord = useGenerationHistoryStore((state) => state.remove);
  const isLogin = useAuthStore((state) => state.isLogin);

  useImperativeHandle(ref, () => ({ showModal }));

  /**
   * 格式化生成时间。
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

  /**
   * 截取故事正文摘要。
   */
  const toExcerpt = (storyText: string) => {
    const flat = storyText.replace(/\s+/g, ' ').trim();
    return flat.length > EXCERPT_LIMIT ? `${flat.slice(0, EXCERPT_LIMIT)}…` : flat;
  };

  /**
   * 回放某条历史：关闭弹窗后重新合成并播放。
   */
  const handleReplay = (record: (typeof records)[number]) => {
    closeModal();
    setTimeout(() => {
      replayGeneration(record).catch(() => {
        GlassToast.show({ icon: 'fail', content: '回放失败，请稍后重试' });
      });
    }, 100);
  };

  const content = useMemo(() => {
    if (!isLogin) {
      return (
        <div className={styles.emptyHistory}>
          <p>登录后查看生成历史</p>
          <p className={styles.emptyHistoryHint}>登录账号即可同步保存你生成的故事</p>
        </div>
      );
    }
    if (records.length === 0) {
      return (
        <div className={styles.emptyHistory}>
          <p>暂无生成历史</p>
          <p className={styles.emptyHistoryHint}>生成故事后会显示在这里，可随时回放</p>
        </div>
      );
    }
    return (
      <div className={styles.historyList}>
        {records.map((record) => (
          <div key={record.id} className={styles.historyItem}>
            <div className={styles.historyContent}>
              <div className={styles.historyPrompt}>{record.prompt}</div>
              <div className={styles.historyExcerpt}>{toExcerpt(record.storyText)}</div>
              <div className={styles.historyMeta}>
                <span>{formatDate(record.createdAt)}</span>
              </div>
            </div>
            <div className={styles.actionButtons}>
              <button
                className={styles.playButton}
                onClick={() => handleReplay(record)}
                aria-label="回放此故事"
              >
                <Play size={16} strokeWidth={2} />
              </button>
              <button
                className={styles.deleteButton}
                onClick={() => removeRecord(record.id)}
                aria-label="删除此历史"
              >
                <Trash2 size={16} strokeWidth={1.8} />
              </button>
            </div>
          </div>
        ))}
      </div>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLogin, records]);

  return (
    <Modal isShow={isShow} title="生成历史" onClose={closeModal}>
      {content}
    </Modal>
  );
});

GenerationHistory.displayName = 'GenerationHistory';

export default GenerationHistory;
