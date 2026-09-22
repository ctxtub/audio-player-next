/**
 * StoryCollection 标题领域函数（纯函数，无副作用）。
 *
 * 首作建集标题链（产品 §2.2）：
 *   AI 短标题 → 严格正文标题（Markdown # / 《》 / 【】）→ prompt 主题短标题 → `未命名作品集`
 * 用户重命名后 titleSource=user，自动流程不得覆盖（产品 §2.2 第 4 条）。
 */

import {
  collapseWhitespace,
  extractHeadingTitle,
  stripPairedQuotes,
  toCodePoints,
  normalizeStoryTitle,
} from '@/lib/storyWork/metadata';
import {
  COLLECTION_TITLE_FALLBACK,
  COLLECTION_TITLE_MAX_LENGTH,
  COLLECTION_TITLE_SUGGESTED_MAX,
  COLLECTION_TITLE_SUGGESTED_MIN,
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
 * AI 标题的展示级校验：只接受 4–18 字短标题，拒绝解释性长句进入作品集标题。
 */
export function normalizeGeneratedCollectionTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/[\r\n]/u.test(raw)) return null;
  const withoutPrefix = collapseWhitespace(raw).replace(/^标题\s*[:：]\s*/u, '');
  const withoutTerminalPunctuation = withoutPrefix.replace(/[。！？!?；;，,、：:]+$/u, '');
  const normalized = normalizeCollectionTitle(withoutTerminalPunctuation);
  const length = toCodePoints(normalized).length;
  if (length < COLLECTION_TITLE_SUGGESTED_MIN || length > COLLECTION_TITLE_SUGGESTED_MAX) {
    return null;
  }
  return normalized;
}

/** 将自动生成/回退标题限制在建议展示长度；用户手动标题不走此规则。 */
function truncateAutomaticCollectionTitle(title: string): string {
  const codePoints = toCodePoints(title);
  if (codePoints.length <= COLLECTION_TITLE_SUGGESTED_MAX) return title;
  return codePoints.slice(0, COLLECTION_TITLE_SUGGESTED_MAX - 1).join('') + '…';
}

/**
 * 从首次创作意图中提炼一个确定性的主题标题。
 * 仅去除常见请求式前后缀，不猜测正文首句；结果始终不超过 AI 标题展示上限。
 */
export function buildCollectionPromptTitle(prompt: string | null | undefined): string {
  if (!prompt) return '';
  const cleaned = collapseWhitespace(prompt).replace(/[。！？!?；;]+$/u, '');
  let candidate = cleaned
    .replace(/^(?:请|请你|麻烦|帮我|给我)?\s*(?:创作|写|讲|生成|构思|来)\s*(?:一篇|一个|一则|一段)?\s*/u, '')
    .replace(/^关于\s*/u, '');

  candidate = candidate.split(/[，,；;]/u, 1)[0]?.trim() ?? '';
  candidate = candidate
    .replace(/(?:的)?(?:短篇|短|睡前)?故事(?:集)?$/u, '')
    .replace(/[。！？!?；;，,、：:]+$/u, '')
    .trim();

  if (!candidate || /^(?:故事|作品|内容)$/u.test(candidate)) {
    candidate = cleaned;
  }
  return truncateAutomaticCollectionTitle(candidate);
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
 * 确定性回退标题链：严格正文标题 → prompt 主题短标题 → `未命名作品集`。
 * @param input 首篇正文与创作提示词
 * @returns 标题与来源（恒为 fallback）
 */
export function buildCollectionFallbackTitle(input: {
  storyText?: string | null;
  prompt?: string | null;
}): ResolvedCollectionTitle {
  const heading = strictStoryTitle(input.storyText);
  if (heading) {
    return { title: truncateAutomaticCollectionTitle(heading), titleSource: 'fallback' };
  }
  const promptTitle = normalizeCollectionTitle(buildCollectionPromptTitle(input.prompt));
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
  const aiTitle = normalizeGeneratedCollectionTitle(input.aiTitle);
  if (aiTitle) {
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
