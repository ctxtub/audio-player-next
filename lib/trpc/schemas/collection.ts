/**
 * StoryCollection 相关 Zod Schemas 与 DTO 定义（change-id 2026-09-15-story-collection-continuous-creation T1）。
 *
 * 集合是故事库第一层实体（产品 §3.3）；详情按 Work position 返回成员。
 */

import { z } from 'zod';
import {
  COLLECTION_TITLE_MAX_LENGTH,
  COLLECTION_TITLE_SOURCES,
  LIBRARY_PAGE_DEFAULT_LIMIT,
  LIBRARY_PAGE_MAX_LIMIT,
  LIBRARY_PAGE_MIN_LIMIT,
} from '@/lib/storyCollection/constants';
import {
  LIBRARY_QUERY_MAX_LENGTH,
  LIBRARY_VIEWS,
  STORY_PROMPT_MAX_LENGTH,
  STORY_PROMPT_MIN_LENGTH,
  STORY_SOURCE_MESSAGE_ID_MAX_LENGTH,
  STORY_TEXT_MAX_LENGTH,
  STORY_TEXT_MIN_LENGTH,
  STORY_VOICE_ID_MAX_LENGTH,
} from '@/lib/storyWork/constants';
import { storyWorkSummaryDtoSchema } from './library';

/** 集合视图类型（与作品库一致：active | favorites | trash） */
export const collectionViewSchema = z.enum(LIBRARY_VIEWS);
export type CollectionView = z.infer<typeof collectionViewSchema>;

/** 集合标题来源 */
export const collectionTitleSourceSchema = z.enum(COLLECTION_TITLE_SOURCES);
export type CollectionTitleSourceDto = z.infer<typeof collectionTitleSourceSchema>;

/** 集合摘要 DTO（故事库列表卡片，刻意不含正文） */
export const collectionSummaryDtoSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  titleSource: collectionTitleSourceSchema,
  workCount: z.number().int().nonnegative(),
  favoritedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StoryCollectionSummaryDTO = z.infer<typeof collectionSummaryDtoSchema>;

/** 集合成员 Work 摘要（复用作品 Summary DTO，附加集合内 position） */
export const collectionWorkSummaryDtoSchema = storyWorkSummaryDtoSchema.extend({
  position: z.number().int().nonnegative(),
});
export type CollectionWorkSummaryDTO = z.infer<typeof collectionWorkSummaryDtoSchema>;

/** 集合详情 DTO（按 Work position 升序返回成员） */
export const collectionDetailDtoSchema = collectionSummaryDtoSchema.extend({
  works: z.array(collectionWorkSummaryDtoSchema),
});
export type StoryCollectionDetailDTO = z.infer<typeof collectionDetailDtoSchema>;

/** collection.list 入参 */
export const collectionListInputSchema = z.object({
  view: collectionViewSchema.default('active'),
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
export type CollectionListInput = z.infer<typeof collectionListInputSchema>;

/** collection.list 返回 */
export const collectionListOutputSchema = z.object({
  items: z.array(collectionSummaryDtoSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type CollectionListOutput = z.infer<typeof collectionListOutputSchema>;

/** 集合 id 入参（UUID 文本） */
export const collectionIdInputSchema = z.object({
  id: z.string().min(1).max(64),
});
export type CollectionIdInput = z.infer<typeof collectionIdInputSchema>;

export const collectionGetInputSchema = collectionIdInputSchema;
export const collectionTrashInputSchema = collectionIdInputSchema;
export const collectionRestoreInputSchema = collectionIdInputSchema;
export const collectionDeleteForeverInputSchema = collectionIdInputSchema;

/** collection.rename 入参 */
export const collectionRenameInputSchema = z.object({
  id: z.string().min(1).max(64),
  title: z
    .string()
    .min(1, '标题不能为空')
    .max(COLLECTION_TITLE_MAX_LENGTH, `标题最多 ${COLLECTION_TITLE_MAX_LENGTH} 字符`),
});
export type CollectionRenameInput = z.infer<typeof collectionRenameInputSchema>;

/** collection.setFavorite 入参 */
export const collectionSetFavoriteInputSchema = z.object({
  id: z.string().min(1).max(64),
  favorite: z.boolean(),
});
export type CollectionSetFavoriteInput = z.infer<typeof collectionSetFavoriteInputSchema>;

/** collection.deleteForever 返回 */
export const collectionDeleteForeverOutputSchema = z.object({
  success: z.literal(true),
  id: z.string().min(1),
});
export type CollectionDeleteForeverOutput = z.infer<
  typeof collectionDeleteForeverOutputSchema
>;

/**
 * collection.promoteArtifact 入参（Artifact → Collection/Work 唯一写入口，产品 §2.1）。
 * conversationId + sourceMessageId 为幂等与归属证据；AI 标题由服务端短超时生成。
 */
export const collectionPromoteInputSchema = z.object({
  conversationId: z.string().min(1).max(64),
  sourceMessageId: z
    .string()
    .min(1)
    .max(STORY_SOURCE_MESSAGE_ID_MAX_LENGTH, `来源消息 ID 过长（最多 ${STORY_SOURCE_MESSAGE_ID_MAX_LENGTH} 字符）`),
  prompt: z
    .string()
    .min(STORY_PROMPT_MIN_LENGTH, '提示词不能为空')
    .max(STORY_PROMPT_MAX_LENGTH, `提示词过长（最多 ${STORY_PROMPT_MAX_LENGTH} 字符）`),
  storyText: z
    .string()
    .min(STORY_TEXT_MIN_LENGTH, '故事正文不能为空')
    .max(STORY_TEXT_MAX_LENGTH, `故事正文过长（最多 ${STORY_TEXT_MAX_LENGTH} 字符）`),
  voiceId: z.string().max(STORY_VOICE_ID_MAX_LENGTH).nullish(),
});
export type CollectionPromoteInput = z.infer<typeof collectionPromoteInputSchema>;
