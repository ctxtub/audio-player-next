/**
 * 标准故事文本分段与指纹计算
 *
 * 用于 Phase 2 段落边界续播的确定性分段与正文漂移检测。
 */

export const SEGMENTATION_VERSION = 'v1';
export const MIN_CHUNK_LENGTH = 80;  // 最小合并阈值 (字/字符)
export const MAX_CHUNK_LENGTH = 350; // 最大超长切分阈值 (字/字符)
export const TARGET_CHUNK_LENGTH = 160; // 目标舒适段落大小

/**
 * 文本标准化规整：抹平平台换行符差异并修剪冗余空白。
 * 哈希与切分均严格基于此标准化字符串输入，而非原始裸字节。
 */
export function normalizeStoryText(text: string): string {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n') // CRLF -> LF
    .replace(/\r/g, '\n')   // CR -> LF
    .replace(/[ \t]+\n/g, '\n') // 清理行尾无意义空格
    .trim();
}

/**
 * 确定性正文切段算法 (复用现有 \n 切分基线，增补边界增强与前向合并)
 */
export function segmentStoryText(rawText: string): string[] {
  const normalized = normalizeStoryText(rawText);
  if (!normalized) return [];

  // 1. 基础段落切分：按 \n 切分并剔除空段
  const rawParagraphs = normalized
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // 2. 超长段落二次拆分 (针对单段无换行长篇故事)
  const splitChunks: string[] = [];
  for (const para of rawParagraphs) {
    if (para.length <= MAX_CHUNK_LENGTH) {
      splitChunks.push(para);
    } else {
      // 依常见句末标点确定性细分
      const sentences = para.match(/[^。！？!?]+[。！？!?]?/g) || [para];
      let buffer = '';
      for (const sent of sentences) {
        if (buffer.length + sent.length > MAX_CHUNK_LENGTH && buffer.length > 0) {
          splitChunks.push(buffer);
          buffer = sent;
        } else {
          buffer += sent;
        }
      }
      if (buffer) splitChunks.push(buffer);
    }
  }

  // 3. 密集短对话前向合并 (针对单行仅数个字的台词段落)
  const mergedParagraphs: string[] = [];
  let mergeAcc = '';

  for (let i = 0; i < splitChunks.length; i++) {
    const chunk = splitChunks[i];
    if (!mergeAcc) {
      mergeAcc = chunk;
    } else if (mergeAcc.length < MIN_CHUNK_LENGTH) {
      mergeAcc += `\n${chunk}`;
    } else {
      mergedParagraphs.push(mergeAcc);
      mergeAcc = chunk;
    }
  }
  if (mergeAcc) {
    // 尾部极短残段合入前一段，避免产生微型音频
    if (mergeAcc.length < 30 && mergedParagraphs.length > 0) {
      mergedParagraphs[mergedParagraphs.length - 1] += `\n${mergeAcc}`;
    } else {
      mergedParagraphs.push(mergeAcc);
    }
  }

  return mergedParagraphs;
}

/**
 * 计算正文短哈希（使用确定性 64 位 FNV-1a 截取前 12 位十六进制字符串）
 * 严格以规范化文本 normalizedText 为输入，保证跨平台、跨客户端与服务端环境哈希确定性。
 */
export function computeStoryContentHash(rawOrNormalizedText: string): string {
  const normalized = normalizeStoryText(rawOrNormalizedText);
  if (!normalized) return '';

  let h1 = 0x811c9dc5;
  let h2 = 0x84222325;

  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code;
    h2 = Math.imul(h2, 0x5bd1e995);
  }

  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return (hex1 + hex2).slice(0, 12);
}
