/**
 * StoryWork 内容标识与指纹计算
 *
 * 必须直接复用现有 @/utils/segmentation 实现：
 * 严禁复制第二份算法、严禁替换为 SHA-256、严禁重新实现。
 */

import {
  computeStoryContentHash,
  normalizeStoryText,
} from '@/utils/segmentation';

export { computeStoryContentHash, normalizeStoryText };

/** 标准规范化函数别名，供跨阶段契约使用 */
export const normalizeStoryTextForHash = normalizeStoryText;
