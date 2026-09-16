/**
 * StoryCollection 标题领域函数（纯函数，无副作用）。
 *
 * 首作建集标题链（产品 §2.2）：
 *   AI 标题 → 严格正文标题（Markdown # / 《》 / 【】）→ prompt 摘要 → `未命名作品集`
 * 用户重命名后 titleSource=user，自动流程不得覆盖（产品 §2.2 第 4 条）。
 */

import {
  buildPromptFallbackTitle,
  collapseWhitespace,
  extractHeadingTitle,
  stripPairedQuotes,
  toCodePoints,
  normalizeStoryTitle,
} from '@/lib/storyWork/metadata';
import {
  COLLECTION_TITLE_FALLBACK,
  COLLECTION_TITLE_MAX_LENGTH,
  type CollectionTitleSource,
} from './constants';

export type ResolvedCollectionTitle = {
  title: string;
  titleSource: CollectionTitleSource;
};

/**
 * 集合标题单点规范化：压缩空白 → 剥离成对引号 → 截断至 80 code points（79 + …）。
 * @param raw 原始标题
 * @returns 规范化标题（可能为空串）
 */
export function normalizeCollectionTitle(raw: string | null | undefined): string {
  if (!raw) return '';
  let cleaned = collapseWhitespace(raw);
  cleaned = stripPairedQuotes(cleaned);
  cleaned = collapseWhitespace(cleaned);
  if (cleaned.length === 0) return '';
  const codePoints = toCodePoints(cleaned);
  if (codePoints.length > COLLECTION_TITLE_MAX_LENGTH) {
    return codePoints.slice(0, COLLECTION_TITLE_MAX_LENGTH - 1).join('') + '…';
  }
  return cleaned;
}

/**
 * 严格正文标题：只认 Markdown # / 《》 / 【】 三种显式格式，绝不猜测普通首句。
 * @param storyText 首篇正文
 * @returns 标题或 null
 */
export function strictStoryTitle(storyText: string | null | undefined): string | null {
  if (!storyText || storyText.trim().length === 0) return null;
  const heading = extractHeadingTitle(storyText);
  return heading && heading.length > 0 ? normalizeCollectionTitle(heading) : null;
}

/**
 * 确定性回退标题链：严格正文标题 → prompt 摘要 → `未命名作品集`。
 * @param input 首篇正文与创作提示词
 * @returns 标题与来源（恒为 fallback）
 */
export function buildCollectionFallbackTitle(input: {
  storyText?: string | null;
  prompt?: string | null;
}): ResolvedCollectionTitle {
  const heading = strictStoryTitle(input.storyText);
  if (heading) {
    return { title: heading, titleSource: 'fallback' };
  }
  const promptTitle = normalizeCollectionTitle(buildPromptFallbackTitle(input.prompt ?? ''));
  if (promptTitle.length > 0) {
    return { title: promptTitle, titleSource: 'fallback' };
  }
  return { title: COLLECTION_TITLE_FALLBACK, titleSource: 'fallback' };
}

/**
 * 首作建集标题解析：AI 标题（可空）优先，否则确定性回退链。
 * @param input AI 标题（可空）、首篇正文、提示词
 * @returns 标题与来源
 */
export function resolveFirstCollectionTitle(input: {
  aiTitle?: string | null;
  storyText?: string | null;
  prompt?: string | null;
}): ResolvedCollectionTitle {
  const aiTitle = normalizeCollectionTitle(input.aiTitle ?? '');
  if (aiTitle.length > 0) {
    return { title: aiTitle, titleSource: 'ai' };
  }
  return buildCollectionFallbackTitle(input);
}

/**
 * 已有集合的标题收敛：
 * - titleSource=user 且已有标题：永远保留（自动流程不得覆盖）；
 * - 已有非空标题：保留（AI 标题只生成一次，追加作品不改名）；
 * - 空标题（legacy / backfill）：按确定性回退链补齐。
 * @param input 现有标题/来源与新作品上下文
 * @returns 标题与来源
 */
export function resolveExistingCollectionTitle(input: {
  existingTitle?: string | null;
  existingTitleSource?: string | null;
  storyText?: string | null;
  prompt?: string | null;
}): ResolvedCollectionTitle {
  const existingTitle = normalizeCollectionTitle(input.existingTitle ?? '');
  if (existingTitle.length > 0) {
    return {
      title: existingTitle,
      titleSource: input.existingTitleSource === 'user' ? 'user' : (input.existingTitleSource as CollectionTitleSource) === 'ai' ? 'ai' : 'fallback',
    };
  }
  return buildCollectionFallbackTitle({ storyText: input.storyText, prompt: input.prompt });
}

/** 复用既有 StoryWork 标题规范化（集合与作品共享 80 code points 上限语义）。 */
export { normalizeStoryTitle };
