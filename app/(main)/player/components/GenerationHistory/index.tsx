'use client';

import React, { useMemo } from 'react';
import { Play, Trash2 } from 'lucide-react';

import GlassToast from '@/components/ui/GlassToast';
import { useGenerationHistoryStore } from '@/stores/generationHistoryStore';
import { useAuthStore } from '@/stores/authStore';
import { replayGeneration } from '@/app/services/storyFlow';
import styles from './index.module.scss';

/** 故事正文摘要的最大字符数。 */
const EXCERPT_LIMIT = 60;

/**
 * 生成历史内联列表：浏览历史生成的故事，支持回放（重合成）与删除。登录专属。
 * 访客显示「登录后查看」空状态；登录无数据显示「暂无生成历史」。
 * @returns 生成历史列表 JSX
 */
const GenerationHistory: React.FC = () => {
  /** 生成历史记录（账号维度同步，登录可见）。 */
  const records = useGenerationHistoryStore((state) => state.records);
  /** 删除某条生成历史。 */
  const removeRecord = useGenerationHistoryStore((state) => state.remove);
  /** 登录态，决定是否展示数据或登录引导。 */
  const isLogin = useAuthStore((state) => state.isLogin);

  /**
   * 格式化生成时间为简短中文日期。
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

  /**
   * 截取故事正文摘要。
   * @param storyText 故事正文
   * @returns 不超过 EXCERPT_LIMIT 字的单行摘要
   */
  const toExcerpt = (storyText: string) => {
    const flat = storyText.replace(/\s+/g, ' ').trim();
    return flat.length > EXCERPT_LIMIT ? `${flat.slice(0, EXCERPT_LIMIT)}…` : flat;
  };

  /**
   * 回放某条历史：重新合成并播放，失败 Toast 提示。
   * @param record 目标历史记录
   */
  const handleReplay = (record: (typeof records)[number]) => {
    replayGeneration(record).catch(() => {
      GlassToast.show({ icon: 'fail', content: '回放失败，请稍后重试' });
    });
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

  return content;
};

export default GenerationHistory;
