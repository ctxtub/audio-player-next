/**
 * StoryWork 领域共享常量定义
 *
 * 冻结 M2/M3/M4 共享的纯领域常量：分页上下限、标题/摘要长度限制、视图与游标协议、缺省投影等。
 */

/** 列表分页默认单页条数 */
export const LIBRARY_PAGE_DEFAULT_LIMIT = 20;

/** 列表分页单页最小条数 */
export const LIBRARY_PAGE_MIN_LIMIT = 1;

/** 列表分页单页最大条数 */
export const LIBRARY_PAGE_MAX_LIMIT = 50;

/** 故事标题最大 Unicode code points 长度 */
export const STORY_TITLE_MAX_LENGTH = 80;

/** Prompt fallback 标题最大 Unicode code points 长度（超过截断为 31 + …） */
export const STORY_TITLE_PROMPT_FALLBACK_MAX_LENGTH = 32;

/** 故事摘要（Excerpt）生成上限（Unicode code points，超过追加 …） */
export const STORY_EXCERPT_MAX_LENGTH = 160;

/** 数据库与 API 层面摘要最大容忍字符数（为未来规则留安全空间） */
export const STORY_EXCERPT_DB_MAX_LENGTH = 240;

/** 列表搜索 Query 最大长度 */
export const LIBRARY_QUERY_MAX_LENGTH = 100;

/** 提示词最小长度 */
export const STORY_PROMPT_MIN_LENGTH = 1;

/** 提示词最大长度 */
export const STORY_PROMPT_MAX_LENGTH = 2000;

/** 正文内容最小长度 */
export const STORY_TEXT_MIN_LENGTH = 1;

/** 正文内容最大长度 */
export const STORY_TEXT_MAX_LENGTH = 20000;

/** 声音标识最大长度 */
export const STORY_VOICE_ID_MAX_LENGTH = 64;

/** 来源消息 ID 最大长度 */
export const STORY_SOURCE_MESSAGE_ID_MAX_LENGTH = 128;

/** 最终兜底标题 */
export const FALLBACK_STORY_TITLE = '未命名故事';

/** 列表默认视图 */
export const LIBRARY_DEFAULT_VIEW = 'active' as const;

/** 列表支持的所有视图类型 */
export const LIBRARY_VIEWS = ['active', 'favorites', 'trash'] as const;

/** 游标版本协议号 */
export const LIBRARY_CURSOR_VERSION = 1;

/** 缺省音频投影（M2 阶段统一下发，M8 后仅替换真实状态与时长，保持结构稳定） */
export const DEFAULT_AUDIO_PROJECTION = {
  status: 'missing',
  durationMs: null,
} as const;
