/**
 * StoryWork 领域派生字段计算逻辑
 *
 * 统一实现故事标题解析链（title chain）、故事摘要截取（excerpt derivation）与正文指纹。
 * 单点收敛文本规范化与长度限制，避免各端推导漂移。
 */

import {
  FALLBACK_STORY_TITLE,
  STORY_EXCERPT_MAX_LENGTH,
  STORY_TITLE_MAX_LENGTH,
  STORY_TITLE_PROMPT_FALLBACK_MAX_LENGTH,
} from './constants';
import { computeStoryContentHash } from '@/utils/segmentation';

export { computeStoryContentHash };

/**
 * 将字符串解析为 Unicode code point 数组（正确支持多字节 Emoji 与生僻字）。
 */
export function toCodePoints(text: string): string[] {
  return Array.from(text);
}

/**
 * 计算 Unicode code points 数量。
 */
export function getCodePointLength(text: string): number {
  return Array.from(text).length;
}

/**
 * 文本基础规范化：
 * 1. 替换回车换行符为统一换行；
 * 2. 压缩连续空白（包含空白字符与换行）为单个空格；
 * 3. 去除首尾空白。
 */
export function collapseWhitespace(text: string): string {
  if (!text) return '';
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 去除首尾成对的引号（支持 ASCII 双引号 `"` 与中文双引号 `“”`）。
 * 仅在首尾确实形成封闭成对引用时剥离，防止损坏如 `“月球” 与 “地球”` 内部合法引号。
 */
export function stripPairedQuotes(text: string): string {
  let s = text.trim();
  let changed = true;

  while (changed && s.length >= 2) {
    changed = false;

    // ASCII 双引号成对剥离
    if (s.startsWith('"') && s.endsWith('"')) {
      const inner = s.slice(1, -1);
      const quoteCount = (s.match(/"/g) || []).length;
      if (quoteCount === 2 || !inner.includes('"')) {
        s = inner.trim();
        changed = true;
        continue;
      }
    }

    // 中文双引号成对剥离
    if (s.startsWith('“') && s.endsWith('”')) {
      const inner = s.slice(1, -1);
      let depth = 1;
      let closedEarly = false;
      for (let i = 0; i < inner.length; i++) {
        if (inner[i] === '“') {
          depth++;
        } else if (inner[i] === '”') {
          depth--;
          if (depth === 0) {
            closedEarly = true;
            break;
          }
        }
      }
      if (!closedEarly && depth === 1) {
        s = inner.trim();
        changed = true;
        continue;
      }
    }
  }

  return s;
}

/**
 * 故事标题单点规范化函数：
 * 1. trim 并压缩连续空白；
 * 2. 剥离首尾成对引号；
 * 3. 最大 80 code points，超长截断为 79 + …。
 */
export function normalizeStoryTitle(rawTitle: string): string {
  if (!rawTitle) return '';
  let cleaned = collapseWhitespace(rawTitle);
  cleaned = stripPairedQuotes(cleaned);
  cleaned = collapseWhitespace(cleaned);

  const codePoints = toCodePoints(cleaned);
  if (codePoints.length > STORY_TITLE_MAX_LENGTH) {
    return codePoints.slice(0, STORY_TITLE_MAX_LENGTH - 1).join('') + '…';
  }
  return cleaned;
}

/**
 * 从正文第一条非空行中严格识别显式标题。
 *
 * 只接受严格格式：
 * - Markdown 标题：`# 标题` / `## 标题` / `### 标题` ...
 * - 书名号标记：`《标题》`
 * - 方括号标记：`【标题】`
 * 且抽取结果在 1..80 code points 之间才视为标题；普通第一句话绝不猜测。
 */
export function extractHeadingTitle(storyText: string): string | null {
  if (!storyText) return null;
  const lines = storyText.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const checkCandidate = (rawGroup: string): string | null => {
      let cleaned = collapseWhitespace(rawGroup);
      cleaned = stripPairedQuotes(cleaned);
      cleaned = collapseWhitespace(cleaned);
      const len = getCodePointLength(cleaned);
      if (len >= 1 && len <= STORY_TITLE_MAX_LENGTH) {
        return cleaned;
      }
      return null;
    };

    // 仅识别第一条非空行；非匹配直接判定失败，不扫描后续段落
    const mdMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (mdMatch) {
      return checkCandidate(mdMatch[1]);
    }

    const bookMatch = line.match(/^《(.+)》$/);
    if (bookMatch) {
      return checkCandidate(bookMatch[1]);
    }

    const bracketMatch = line.match(/^【(.+)】$/);
    if (bracketMatch) {
      return checkCandidate(bracketMatch[1]);
    }

    // 第一条非空行不是严格标题格式
    return null;
  }

  return null;
}

/**
 * 从 prompt 生成确定性兜底标题：
 * trim → 换行变空格 → 连续空白压缩 → 前 32 code points（超过截断为 31 + …）。
 */
export function buildPromptFallbackTitle(prompt: string): string {
  if (!prompt) return '';
  const cleaned = collapseWhitespace(prompt);
  const codePoints = toCodePoints(cleaned);
  if (codePoints.length <= STORY_TITLE_PROMPT_FALLBACK_MAX_LENGTH) {
    return cleaned;
  }
  return (
    codePoints.slice(0, STORY_TITLE_PROMPT_FALLBACK_MAX_LENGTH - 1).join('') + '…'
  );
}

/** 标题推导输入参数 */
export interface ResolveStoryTitleParams {
  proposedTitle?: string | null;
  title?: string | null;
  storyText?: string | null;
  prompt?: string | null;
}

/**
 * 故事标题推导统一管线（Pipeline）：
 * 规则 1：调用方显式提供的 title（proposedTitle / title）
 * 规则 2：正文中识别的严格标题（Markdown # / 《...》 / 【...】）
 * 规则 3：从 prompt 截取的确定性 fallback（<=32 字符）
 * 规则 4：最终安全兜底「未命名故事」
 */
export function resolveStoryTitle(params: ResolveStoryTitleParams): string {
  // 规则 1：调用方显式 title
  const explicit = params.proposedTitle ?? params.title;
  if (explicit && explicit.trim().length > 0) {
    const normalized = normalizeStoryTitle(explicit);
    if (normalized.length > 0) {
      return normalized;
    }
  }

  // 规则 2：正文严格格式显式标题
  if (params.storyText && params.storyText.trim().length > 0) {
    const heading = extractHeadingTitle(params.storyText);
    if (heading) {
      return heading;
    }
  }

  // 规则 3：提示词确定性 fallback
  if (params.prompt && params.prompt.trim().length > 0) {
    const promptTitle = buildPromptFallbackTitle(params.prompt);
    if (promptTitle.length > 0) {
      return promptTitle;
    }
  }

  // 规则 4：最终兜底
  return FALLBACK_STORY_TITLE;
}

/**
 * 构建故事摘要（Excerpt）：
 * 1. trim()；
 * 2. \r\n → \n；
 * 3. 连续 whitespace 压成单个空格；
 * 4. 最多取 160 Unicode code points；
 * 5. 超过则添加 …。
 */
export function buildStoryExcerpt(storyText: string | null | undefined): string {
  if (!storyText) return '';
  const cleaned = collapseWhitespace(storyText);
  const codePoints = toCodePoints(cleaned);
  if (codePoints.length <= STORY_EXCERPT_MAX_LENGTH) {
    return cleaned;
  }
  return codePoints.slice(0, STORY_EXCERPT_MAX_LENGTH).join('') + '…';
}
