/**
 * Client-side Legacy StoryCard read compatibility boundary（M4-09）。
 *
 * 职责：把所有客户端 Legacy StoryCard 结构知识压缩到此唯一纯函数模块；
 * 现代 chatStore / Artifact 状态机不再直接理解 Legacy wire shape，只经由
 * 本模块的 helper 查询“是不是故事 / 有没有可播放历史卡”。
 *
 * 设计原则（冻结）：
 * 1. 纯函数：无 React、无 Zustand、无 network、无 libraryClient、无 promotion、
 *    无 generation transport、无 playback store、无 server/Prisma、无 Settings。
 *    只依赖 Chat types（MessagePart / StoryCardPart）。
 * 2. 只读：仅返回规范化只读视图或存在性判定；绝不创建 Complete Artifact、
 *    绝不触发 StoryWork / promotion / library.create、不做 History ↔ Artifact
 *    转换、不做 migration/backfill。
 * 3. 语义 no-op：每个 helper 与 M4-08 前 chatStore 内联分支逐字等价；
 *    任何 M4-08 合法输入在 M4-09 前后行为完全一致。
 */

import type { MessagePart, StoryCardPart } from '../../types/chat';

/**
 * 解码/规范化历史 Legacy StoryCardPart（M4-01 B2 契约逐字迁移，M4-09 relocation）。
 *
 * 铁律契约：
 * 1. 严格只读兼容：仅返回规范化后的 StoryCardPart，用于历史只读渲染与播放展示；
 * 2. 严禁转为 CompleteChatArtifact：绝不赋予 Legacy 卡片 promotion 状态机能力；
 * 3. 避免会话恢复重入时自动发起 library.create 写入 StoryWork。
 *
 * 校验逐字等价：必须 object、type === 'storyCard'、storyText 为非空 string
 * （trim 后非空）、audioUrl 为 string，否则 null。
 *
 * @param card 待解码的历史卡片（unknown JSON）。
 * @returns 规范化后的 StoryCardPart；非法一律 null。
 */
export function decodeLegacyStoryCard(card: unknown): StoryCardPart | null {
  if (card === null || typeof card !== 'object') {
    return null;
  }
  const c = card as Record<string, unknown>;
  if (c.type !== 'storyCard') {
    return null;
  }
  if (typeof c.storyText !== 'string' || c.storyText.trim() === '') {
    return null;
  }
  if (typeof c.audioUrl !== 'string') {
    return null;
  }

  return {
    type: 'storyCard',
    storyText: c.storyText,
    audioUrl: c.audioUrl,
  };
}

/**
 * 历史兼容卡存在性（M4-09 containment）。
 * 等价于 M4-08 前 chatStore stream.intent 分支的内联判定：
 * parts 内是否存在 type === 'storyCard' 的片段。
 *
 * @param parts 消息片段数组（可为 undefined）。
 * @returns 存在历史兼容卡返回 true，否则 false。
 */
export function hasLegacyStoryCard(parts: MessagePart[] | undefined): boolean {
  if (!parts) {
    return false;
  }
  return parts.some((p) => p.type === 'storyCard');
}

/**
 * 故事存在性（M4-09 containment）。
 * 保持 M4-08 前 isLatestMessage() 的语义：历史兼容卡存在 OR 现代
 * storyArtifact 存在；不额外要求现代 storyText 非空。
 * 空正文现代 Artifact（artifact exists, storyText === ''）仍视为故事存在，
 * 不得与 hasStoryContent() 的语义混淆。
 *
 * @param parts 消息片段数组（可为 undefined）。
 * @returns 任一故事形态存在返回 true，否则 false。
 */
export function hasAnyStoryPart(parts: MessagePart[] | undefined): boolean {
  if (!parts) {
    return false;
  }
  return parts.some((p) => p.type === 'storyCard' || p.type === 'storyArtifact');
}

/**
 * 故事内容存在性（M4-09 containment）。
 * 保持 M4-08 前 hasStoryMessages() 的语义：历史兼容卡 OR 现代
 * StoryArtifact 且 storyText.trim() !== ''。
 * 现代空白正文（whitespace-only）不计入；历史兼容卡不做正文非空要求
 * （与当时内联分支一致：只要 type 为兼容卡即计入）。
 *
 * @param parts 消息片段数组（可为 undefined）。
 * @returns 有可计数的故事内容返回 true，否则 false。
 */
export function hasStoryContent(parts: MessagePart[] | undefined): boolean {
  if (!parts) {
    return false;
  }
  return parts.some((p) => {
    if (p.type === 'storyCard') {
      return true;
    }
    if (p.type === 'storyArtifact') {
      const text = (p as unknown as { artifact?: { storyText?: unknown } }).artifact?.storyText;
      return typeof text === 'string' && text.trim() !== '';
    }
    return false;
  });
}

/**
 * 查找首个可播放历史兼容卡（M4-09 containment）。
 * 严格保持 M4-08 前 nextStorySegment() 的行为：只寻找 Legacy 兼容卡，
 * 并要求 audioUrl 与 storyText 均有效（truthy 非空）；现代 StoryArtifact
 * 永不参加该 selector；不产生 StoryWork / audio manifest 查询。
 *
 * @param parts 单条消息的片段数组（可为 undefined）。
 * @returns 首个可播放历史兼容卡；无则 undefined。
 */
export function findLegacyPlayableStoryCard(
  parts: MessagePart[] | undefined,
): StoryCardPart | undefined {
  if (!parts) {
    return undefined;
  }
  for (const p of parts) {
    if (p.type !== 'storyCard') {
      continue;
    }
    const card = p as StoryCardPart;
    if (card.audioUrl && card.storyText) {
      return card;
    }
  }
  return undefined;
}
