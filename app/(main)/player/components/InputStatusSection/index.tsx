'use client';

import React, { useRef } from 'react';
import { useRouter } from 'next/navigation';
import HistoryRecords, { HistoryRecordsRef } from '@/app/(main)/player/components/HistoryRecords';
import GenerationHistory, { GenerationHistoryRef } from '@/app/(main)/player/components/GenerationHistory';
import { useChatStore } from '@/stores/chatStore';

import styles from './index.module.scss';

/**
 * 播放器页历史操作条：仅承载「历史记录（提示词历史）」与「生成历史」两个入口。
 * 故事生成能力已统一收归创作（chat）页；选择历史提示词将跳转 chat 预填并自动发送。
 * （文件夹名沿用 InputStatusSection 以减少改动面，其职责已变为历史入口。）
 */
const InputStatusSection: React.FC = () => {
  /** 路由：选择提示词后跳转创作页。 */
  const router = useRouter();
  /** 提示词历史弹窗引用。 */
  const historyRecordsRef = useRef<HistoryRecordsRef>(null);
  /** 生成历史弹窗引用。 */
  const generationHistoryRef = useRef<GenerationHistoryRef>(null);
  /** 设置跨页待发提示词。 */
  const setPendingAutoSend = useChatStore((state) => state.setPendingAutoSend);

  /** 打开提示词历史弹窗。 */
  const handleHistoryButtonClick = () => {
    historyRecordsRef.current?.showModal();
  };

  /** 打开生成历史弹窗。 */
  const handleGenerationHistoryClick = () => {
    generationHistoryRef.current?.showModal();
  };

  /** 选择历史提示词：交给 chat 自动发送（预填 + 发送），并跳转创作页。 */
  const handleSelectHistoryPrompt = (prompt: string) => {
    setPendingAutoSend(prompt);
    router.push('/chat');
  };

  return (
    <div className={styles.container}>
      <div className={styles.quickButtons}>
        <button
          className={`${styles.quickButton} ${styles.historyButton}`}
          onClick={handleHistoryButtonClick}
          title="查看历史提示词记录"
        >
          历史记录
        </button>
        <button
          className={`${styles.quickButton} ${styles.historyButton}`}
          onClick={handleGenerationHistoryClick}
          title="查看生成历史并回放"
        >
          生成历史
        </button>
      </div>

      {/* 历史记录弹窗 */}
      <HistoryRecords ref={historyRecordsRef} onSelectPrompt={handleSelectHistoryPrompt} />

      {/* 生成历史弹窗 */}
      <GenerationHistory ref={generationHistoryRef} />
    </div>
  );
};

export default InputStatusSection;
