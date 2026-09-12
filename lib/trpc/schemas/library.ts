/**
 * Library (StoryWork) 相关 Zod Schemas 与 DTO 定义
 *
 * 冻结 M2/M3/M4/M5 统一消费的数据传输契约与接口校验。
 */

import { z } from 'zod';
import {
  DEFAULT_AUDIO_PROJECTION,
  LIBRARY_PAGE_DEFAULT_LIMIT,
  LIBRARY_PAGE_MAX_LIMIT,
  LIBRARY_PAGE_MIN_LIMIT,
  LIBRARY_QUERY_MAX_LENGTH,
  LIBRARY_VIEWS,
  STORY_PROMPT_MAX_LENGTH,
  STORY_PROMPT_MIN_LENGTH,
  STORY_SOURCE_MESSAGE_ID_MAX_LENGTH,
  STORY_TEXT_MAX_LENGTH,
  STORY_TEXT_MIN_LENGTH,
  STORY_TITLE_MAX_LENGTH,
  STORY_VOICE_ID_MAX_LENGTH,
} from '@/lib/storyWork/constants';

export { DEFAULT_AUDIO_PROJECTION };

/** 音频就绪状态枚举 */
export const storyAudioStatusSchema = z.enum([
  'missing',
  'preparing',
  'ready',
  'failed',
]);
export type StoryAudioStatus = z.infer<typeof storyAudioStatusSchema>;

/**
 * 统一音频投影结构（M2 阶段占位，M8 填充真实值，DTO 结构恒定）
 */
export const storyAudioProjectionSchema = z.object({
  status: storyAudioStatusSchema,
  durationMs: z.number().int().nullable(),
});
export type StoryAudioProjection = z.infer<typeof storyAudioProjectionSchema>;

/**
 * 构建统一的缺省 missing 音频投影
 */
export function createMissingAudioProjection(): StoryAudioProjection {
  return {
    status: DEFAULT_AUDIO_PROJECTION.status,
    durationMs: DEFAULT_AUDIO_PROJECTION.durationMs,
  };
}

/**
 * 故事摘要 DTO（用于 Library List 列表渲染，刻意不包含庞大正文与 prompt）
 */
export const storyWorkSummaryDtoSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  excerpt: z.string(),
  voiceId: z.string(),
  contentHash: z.string(),
  favoritedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  audio: storyAudioProjectionSchema,
});
export type StoryWorkSummaryDTO = z.infer<typeof storyWorkSummaryDtoSchema>;

/**
 * 故事详情 DTO（包含完整正文、原始提示词与来源消息追踪）
 */
export const storyWorkDetailDtoSchema = storyWorkSummaryDtoSchema.extend({
  prompt: z.string(),
  storyText: z.string(),
  sourceMessageId: z.string().nullable(),
});
export type StoryWorkDetailDTO = z.infer<typeof storyWorkDetailDtoSchema>;

/** 故事库视图类型 */
export const libraryViewSchema = z.enum(LIBRARY_VIEWS);
export type LibraryView = z.infer<typeof libraryViewSchema>;

/**
 * library.list 查询入参契约
 */
export const libraryListInputSchema = z.object({
  view: libraryViewSchema.default('active'),
  query: z
    .string()
    .max(LIBRARY_QUERY_MAX_LENGTH, `搜索词最多 ${LIBRARY_QUERY_MAX_LENGTH} 字符`)
    .optional()
    .transform((q) => (q !== undefined ? q.trim() : undefined)),
  cursor: z.string().optional(),
  limit: z
    .number()
    .int()
    .min(LIBRARY_PAGE_MIN_LIMIT, `每页至少 ${LIBRARY_PAGE_MIN_LIMIT} 条`)
    .max(LIBRARY_PAGE_MAX_LIMIT, `每页最多 ${LIBRARY_PAGE_MAX_LIMIT} 条`)
    .default(LIBRARY_PAGE_DEFAULT_LIMIT),
});
export type LibraryListInput = z.infer<typeof libraryListInputSchema>;

/**
 * library.list 返回结果契约
 */
export const libraryListOutputSchema = z.object({
  items: z.array(storyWorkSummaryDtoSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type LibraryListOutput = z.infer<typeof libraryListOutputSchema>;

/**
 * 单记录 ID 查询/操作入参契约
 */
export const libraryIdInputSchema = z.object({
  id: z.number().int().positive('ID 必须为正整数'),
});
export type LibraryIdInput = z.infer<typeof libraryIdInputSchema>;

/**
 * library.get 入参
 */
export const libraryGetInputSchema = libraryIdInputSchema;
export type LibraryGetInput = z.infer<typeof libraryGetInputSchema>;

/**
 * library.create 入参契约（供 M4 等创作者使用）
 */
export const libraryCreateInputSchema = z.object({
  title: z
    .string()
    .max(STORY_TITLE_MAX_LENGTH, `标题最多 ${STORY_TITLE_MAX_LENGTH} 字符`)
    .nullish(),
  prompt: z
    .string()
    .min(STORY_PROMPT_MIN_LENGTH, '提示词不能为空')
    .max(STORY_PROMPT_MAX_LENGTH, `提示词过长（最多 ${STORY_PROMPT_MAX_LENGTH} 字符）`),
  storyText: z
    .string()
    .min(STORY_TEXT_MIN_LENGTH, '故事正文不能为空')
    .max(STORY_TEXT_MAX_LENGTH, `故事正文过长（最多 ${STORY_TEXT_MAX_LENGTH} 字符）`),
  voiceId: z.string().max(STORY_VOICE_ID_MAX_LENGTH).nullish(),
  sourceMessageId: z.string().max(STORY_SOURCE_MESSAGE_ID_MAX_LENGTH).nullish(),
});
export type LibraryCreateInput = z.infer<typeof libraryCreateInputSchema>;

/**
 * library.rename 入参契约
 */
export const libraryRenameInputSchema = z.object({
  id: z.number().int().positive('ID 必须为正整数'),
  title: z
    .string()
    .min(1, '标题不能为空')
    .max(STORY_TITLE_MAX_LENGTH, `标题最多 ${STORY_TITLE_MAX_LENGTH} 字符`),
});
export type LibraryRenameInput = z.infer<typeof libraryRenameInputSchema>;

/**
 * library.setFavorite 入参契约
 */
export const librarySetFavoriteInputSchema = z.object({
  id: z.number().int().positive('ID 必须为正整数'),
  favorite: z.boolean(),
});
export type LibrarySetFavoriteInput = z.infer<typeof librarySetFavoriteInputSchema>;

/**
 * library.trash 入参契约
 */
export const libraryTrashInputSchema = libraryIdInputSchema;
export type LibraryTrashInput = z.infer<typeof libraryTrashInputSchema>;

/**
 * library.restore 入参契约
 */
export const libraryRestoreInputSchema = libraryIdInputSchema;
export type LibraryRestoreInput = z.infer<typeof libraryRestoreInputSchema>;

/**
 * library.deletePermanently 入参契约
 */
export const libraryDeletePermanentlyInputSchema = libraryIdInputSchema;
export type LibraryDeletePermanentlyInput = z.infer<typeof libraryDeletePermanentlyInputSchema>;

/**
 * library.deletePermanently 出参契约
 */
export const libraryDeletePermanentlyOutputSchema = z.object({
  success: z.literal(true),
  id: z.number().int().positive(),
});
export type LibraryDeletePermanentlyOutput = z.infer<typeof libraryDeletePermanentlyOutputSchema>;

