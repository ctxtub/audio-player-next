import type {
  StoryWorkSummaryDTO,
  StoryWorkDetailDTO,
} from '@/lib/client/library';

/**
 * 故事库列表项展示模型（ViewModel）
 *
 * 封装稳定 DTO，并预留注入播放进度（M5）的缝隙。
 * M3 阶段 progress 注入恒为 null；M5 将根据 storyId 批量装配进度投影，无需重写 Query 或缓存。
 */
export type LibraryItemViewModel<TProgress = null> = StoryWorkSummaryDTO & {
  progress: TProgress | null;
};

/**
 * 故事库详情展示模型（ViewModel）
 */
export type LibraryDetailViewModel<TProgress = null> = StoryWorkDetailDTO & {
  progress: TProgress | null;
};

/**
 * 合成单个作品列表项 ViewModel
 *
 * 保障输出契约：
 * 1. 严格保持作品核心身份与元数据（id, title, excerpt, voiceId, contentHash, favoritedAt, deletedAt, createdAt, updatedAt）；
 * 2. 严格保持 audio 投影结构（audio.status, audio.durationMs，为 M8 音频合成预留）；
 * 3. 严格注入 progress 投影（无进度时为 null）。
 */
export function composeLibraryItemViewModel<TProgress = null>(
  story: StoryWorkSummaryDTO,
  progress: TProgress | null = null
): LibraryItemViewModel<TProgress> {
  return {
    ...story,
    audio: story.audio,
    progress: progress ?? null,
  };
}

/**
 * 合成单个作品详情 ViewModel
 */
export function composeLibraryDetailViewModel<TProgress = null>(
  story: StoryWorkDetailDTO,
  progress: TProgress | null = null
): LibraryDetailViewModel<TProgress> {
  return {
    ...story,
    audio: story.audio,
    progress: progress ?? null,
  };
}

/**
 * 批量合成作品列表项 ViewModel（方便列表视图与 M5 批量进度投影合成）
 */
export function composeLibraryItemListViewModel<TProgress = null>(
  stories: StoryWorkSummaryDTO[],
  progressMap?: Record<number, TProgress> | null
): LibraryItemViewModel<TProgress>[] {
  return stories.map((story) =>
    composeLibraryItemViewModel(
      story,
      progressMap && story.id in progressMap ? progressMap[story.id] : null
    )
  );
}

export {
  groupStoryWorksByTime,
  getTimeGroupLabel,
  type TimeGroupLabel,
  type StoryWorkTimeGroup,
} from './libraryGrouping';
