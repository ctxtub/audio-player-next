'use client';

import React from 'react';
import Link from 'next/link';
import { ArrowLeft, Clock, Mic, FileText, Hash, Bookmark, Sparkles } from 'lucide-react';
import type { LibraryDetailViewModel } from '@/lib/client/libraryViewModel';
import styles from './storyDetail.module.scss';

export interface StoryDetailProps {
  work: LibraryDetailViewModel;
}

/**
 * 格式化持续时间（毫秒转为分:秒）
 */
function formatDuration(durationMs?: number): string {
  if (!durationMs || durationMs <= 0) return '0:00';
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * 格式化日期时间
 */
function formatDateTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

/**
 * 故事作品详情展示组件（M3-06 纯只读）
 *
 * 核心边界规范：
 * 1. 纯只读展示：不暴露任何 Rename / Favorite / Trash / Restore / Permanent Delete mutation 行为（归 M3-07 接管）；
 * 2. 字段保真：严格仅读取 StoryWorkDetail 已有字段，绝不跨越读取生成历史、播放进度或音频内部表；
 * 3. 播放进度缝隙：严格保持 work.progress === null（等待 M5 进度系统接入）。
 */
export const StoryDetail: React.FC<StoryDetailProps> = ({ work }) => {
  return (
    <div
      className={styles.detailContainer}
      data-testid="story-detail-container"
      data-work-id={work.id}
      data-has-progress={work.progress !== null}
    >
      {/* 顶部导航与返回 */}
      <nav className={styles.topNav}>
        <Link
          href="/library"
          className={styles.backLink}
          data-testid="back-to-library-link"
        >
          <ArrowLeft size={16} />
          <span>返回故事库</span>
        </Link>
        <span className={styles.idBadge} data-testid="story-detail-id">
          #{work.id}
        </span>
      </nav>

      {/* 标题与元信息 Hero */}
      <header className={styles.detailHero}>
        <div className={styles.titleRow}>
          <h1 className={styles.title} data-testid="story-detail-title">
            {work.title}
          </h1>
          {work.favoritedAt ? (
            <span
              className={styles.favoriteBadge}
              data-testid="story-detail-favorite-badge"
              title={`收藏于 ${formatDateTime(work.favoritedAt)}`}
            >
              <Bookmark size={14} />
              <span>已收藏</span>
            </span>
          ) : null}
        </div>

        {/* 元数据标签组 */}
        <div className={styles.metaRow}>
          <span className={styles.metaItem} data-testid="story-detail-created-at">
            <Clock size={14} />
            <span>创建于 {formatDateTime(work.createdAt)}</span>
          </span>
          <span className={styles.metaItem} data-testid="story-detail-voice">
            <Mic size={14} />
            <span>音色: {work.voiceId}</span>
          </span>
          <span className={styles.metaItem} data-testid="story-detail-audio-status">
            <span>音频: {work.audio?.status ?? 'none'}</span>
            {work.audio?.durationMs ? (
              <span> ({formatDuration(work.audio.durationMs)})</span>
            ) : null}
          </span>
          <span className={styles.metaItem} data-testid="story-detail-hash">
            <Hash size={14} />
            <span>Hash: {work.contentHash ? work.contentHash.slice(0, 10) : 'none'}</span>
          </span>
        </div>
      </header>

      {/* 摘要与导读 */}
      {work.excerpt ? (
        <section className={styles.excerptSection} data-testid="story-detail-excerpt">
          <p className={styles.excerptText}>{work.excerpt}</p>
        </section>
      ) : null}

      {/* 正文内容区 */}
      <section className={styles.textSection}>
        <h2 className={styles.sectionHeading}>
          <FileText size={18} />
          <span>故事正文</span>
        </h2>
        <div className={styles.storyText} data-testid="story-detail-text">
          {work.storyText}
        </div>
      </section>

      {/* 原始生成提示词 Prompt */}
      {work.prompt ? (
        <section className={styles.promptSection}>
          <h2 className={styles.sectionHeading}>
            <Sparkles size={18} />
            <span>创作提示词</span>
          </h2>
          <div className={styles.promptBox} data-testid="story-detail-prompt">
            {work.prompt}
          </div>
        </section>
      ) : null}

      {/* 消息来源追踪 */}
      {work.sourceMessageId ? (
        <footer className={styles.footerInfo} data-testid="story-detail-source-message">
          <span>来源对话消息: {work.sourceMessageId}</span>
        </footer>
      ) : null}
    </div>
  );
};

export default StoryDetail;
