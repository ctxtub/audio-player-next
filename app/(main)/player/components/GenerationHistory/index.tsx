'use client';

import React from 'react';
import { Play } from 'lucide-react';

import GlassToast from '@/components/ui/GlassToast';
import { useGenerationHistoryStore } from '@/stores/generationHistoryStore';
import { useAuthStore } from '@/stores/authStore';
import { replayGeneration } from '@/app/services/storyFlow';
import {
  HistoryList,
  HistoryListItem,
  HistoryEmpty,
} from '@/app/(main)/player/components/HistoryList';

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

  if (!isLogin) {
    return (
      <HistoryEmpty title="登录后查看生成历史" hint="登录账号即可同步保存你生成的故事" />
    );
  }

  if (records.length === 0) {
    return (
      <HistoryEmpty title="暂无生成历史" hint="生成故事后会显示在这里，可随时回放" />
    );
  }

  return (
    <HistoryList>
      {records.map((record) => (
        <HistoryListItem
          key={record.id}
          title={record.prompt}
          excerpt={toExcerpt(record.storyText)}
          meta={<span>{formatDate(record.createdAt)}</span>}
          primaryAction={{
            icon: <Play size={16} strokeWidth={2} />,
            label: '回放此故事',
            onClick: () => handleReplay(record),
          }}
          onDelete={() => removeRecord(record.id)}
          deleteLabel="删除此历史"
        />
      ))}
    </HistoryList>
  );
};

export default GenerationHistory;
