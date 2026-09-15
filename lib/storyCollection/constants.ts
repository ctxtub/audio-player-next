/**
 * StoryCollection / Conversation 领域共享常量（change-id 2026-09-15-story-collection-continuous-creation T1）。
 *
 * 冻结集合标题、标题来源、会话状态与集合游标协议，避免各端推导漂移。
 */

/** 集合标题最大 Unicode code points 长度（与产品 §2.2 存储上限一致） */
export const COLLECTION_TITLE_MAX_LENGTH = 80;

/** 集合标题最终确定性兜底（产品 §2.2） */
export const COLLECTION_TITLE_FALLBACK = '未命名作品集';

/** 集合标题来源枚举：AI 生成 | 确定性回退 | 用户手动 */
export const COLLECTION_TITLE_SOURCES = ['ai', 'fallback', 'user'] as const;

/** 集合标题来源类型 */
export type CollectionTitleSource = (typeof COLLECTION_TITLE_SOURCES)[number];

/** 会话状态枚举：active（当前）| closed（已结束） */
export const CONVERSATION_STATES = ['active', 'closed'] as const;

/** 会话状态类型 */
export type ConversationState = (typeof CONVERSATION_STATES)[number];

/** 会话 / 集合 id 形态（service 生成的 UUID v4 文本） */
export const CONVERSATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** AI 集合标题生成短超时（毫秒；失败不阻断入库，产品 §2.2） */
export const COLLECTION_AI_TITLE_TIMEOUT_MS = 1500;

/** AI 集合标题建议展示区间（仅提示词约束，不参与存储校验） */
export const COLLECTION_TITLE_SUGGESTED_MIN = 4;
export const COLLECTION_TITLE_SUGGESTED_MAX = 18;

/** 集合游标协议版本号 */
export const COLLECTION_CURSOR_VERSION = 1;

/** 列表分页沿用 StoryWork 库的上下限（集合与作品共享分页语义） */
export { LIBRARY_PAGE_DEFAULT_LIMIT, LIBRARY_PAGE_MAX_LIMIT, LIBRARY_PAGE_MIN_LIMIT } from '@/lib/storyWork/constants';
