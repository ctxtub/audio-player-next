/**
 * AI 集合标题生成（change-id 2026-09-15-story-collection-continuous-creation）。
 *
 * 首作建集时在事务外短超时生成标题；失败/超时绝不阻断入库（产品 §2.2）。
 * 默认生成器调用 Chat Completion；测试经 options.generate 注入确定性实现，绝不触网。
 */

import { getOpenAIConfig, getOpenAIClient } from './openai';
import { normalizeCollectionTitle } from '@/lib/storyCollection/title';
import {
  COLLECTION_TITLE_SUGGESTED_MAX,
  COLLECTION_TITLE_SUGGESTED_MIN,
  COLLECTION_AI_TITLE_TIMEOUT_MS,
} from '@/lib/storyCollection/constants';

export type CollectionTitleInput = {
  storyText: string;
  prompt: string;
};

export type CollectionTitleGenerator = (input: CollectionTitleInput) => Promise<string | null>;

/**
 * 默认 AI 标题生成器：调用对话模型，要求输出 4–18 字简洁中文标题。
 * 缺失环境配置时抛错，由 generateCollectionTitleSafely 兜底。
 */
export const defaultCollectionTitleGenerator: CollectionTitleGenerator = async ({
  storyText,
  prompt,
}) => {
  const config = getOpenAIConfig();
  const client = getOpenAIClient();
  const response = await client.chat.completions.create({
    model: config.storyModel,
    temperature: 0.3,
    max_tokens: 48,
    messages: [
      {
        role: 'system',
        content:
          '你是故事作品集标题助手。根据创作意图与首篇正文，生成一个表达整组内容共同主题的简洁中文标题，' +
          `长度 ${COLLECTION_TITLE_SUGGESTED_MIN}–${COLLECTION_TITLE_SUGGESTED_MAX} 个中文字符。` +
          '只输出标题本身，不要引号、标点、前后缀或解释。',
      },
      {
        role: 'user',
        content: `创作意图：${prompt}\n首篇正文：${storyText.slice(0, 600)}`,
      },
    ],
  });
  return response.choices?.[0]?.message?.content ?? '';
};

export type GenerateCollectionTitleOptions = {
  /** 短超时毫秒数（默认 COLLECTION_AI_TITLE_TIMEOUT_MS）。 */
  timeoutMs?: number;
  /** 生成器注入（测试专用；缺省走默认 OpenAI 生成器）。 */
  generate?: CollectionTitleGenerator;
};

/**
 * 短超时安全生成集合标题：任何失败/超时/空结果返回 null，绝不抛错。
 * @param input 首篇正文与提示词
 * @param options 超时与生成器注入
 * @returns 规范化标题或 null
 */
export async function generateCollectionTitleSafely(
  input: CollectionTitleInput,
  options?: GenerateCollectionTitleOptions,
): Promise<string | null> {
  const timeoutMs = options?.timeoutMs ?? COLLECTION_AI_TITLE_TIMEOUT_MS;
  const generate = options?.generate ?? defaultCollectionTitleGenerator;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('collection-title-timeout')), timeoutMs);
    });
    const raw = await Promise.race([generate(input), timeout]);
    const normalized = normalizeCollectionTitle(typeof raw === 'string' ? raw : '');
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
