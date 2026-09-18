/**
 * Chat Promotion Orchestration（）。
 *
 * 薄编排层：complete → startPromotion() → promoteStoryArtifact() → ready / promotion_failed。
 * 本模块只做「状态机推进（纯函数）＋ 唯一 I/O 通道调用」，不持有任何归属守卫状态：
 * stale 归属（assistant message id＋ 瞬态 token / epoch / 在途去重）
 * 由调用方（stores/chatStore 闭包瞬态守卫）持有，token 绝不进入持久领域模型。
 *
 * 契约：
 * 1. 状态机推进只用 lib/client/chatArtifactState 纯函数（startPromotion / markPromotionSuccess / markPromotionFailed）。
 * 2. I/O 只走 lib/client/storyArtifactPromotion.promoteStoryArtifact（ 唯一通道），
 *    不直调门面 create，不 import server/Prisma/raw trpc，不碰 generation transport。
 * 3. 真实调用链唯一入口：直接走冻结门面缺省，不得注入替换。
 * 4. 错误原样上抛（尤其 CONFLICT）：不包装、不换 sourceMessageId、不触发重生成，由调用方落为 promotion_failed。
 * 5. 不读 Settings、不补 prompt、不改 delivery——快照与投递语义归调用方与既有 handler。
 */

import {
  markPromotionFailed,
  markPromotionSuccess,
  startPromotion,
} from '@/lib/client/chatArtifactState';
import { promoteStoryArtifact } from '@/lib/client/storyArtifactPromotion';
import type {
  CompleteChatArtifact,
  PromotingChatArtifact,
  PromotionFailedChatArtifact,
  ReadyChatArtifact,
} from '@/types/chatArtifact';
import type { StoryWorkDetailDTO } from '@/lib/trpc/schemas/library';

/**
 * 可作为 promotion 源的 Artifact（初次 complete / 重试源 promotion_failed）。
 * 注意：promoting 快照本身不可再传 adapter（ fail-fast），调用方须同时保留本源快照。
 */
export type PromotionSourceArtifact =
  | CompleteChatArtifact
  | PromotionFailedChatArtifact;

/**
 * 由 complete / promotion_failed 进入 promoting（startPromotion 纯包装）。
 * 缺 prompt snapshot 等非法源由状态机/调用方决定停留 complete，本函数只透传抛错。
 */
export function beginPromotion(
  source: PromotionSourceArtifact,
): PromotingChatArtifact {
  return startPromotion(source);
}

/**
 * 执行唯一 I/O：源快照 + 当前会话归属 → adapter → collection.promoteArtifact → StoryWorkDetailDTO。
 * 错误（含 CONFLICT）原样上抛，绝不改写 sourceMessageId 或触发重生成。
 *
 * @param source 可 promotion 的 Artifact 源快照
 * @param conversationId 当前 active 会话 id（会话级 promotion 归属证据）
 */
export async function executePromotionCreate(
  source: PromotionSourceArtifact,
  conversationId: string,
): Promise<StoryWorkDetailDTO> {
  return promoteStoryArtifact(source, { conversationId });
}

/**
 * 将归属校验通过的 promoting 按服务端返回落为 ready（promoting → ready）。
 * 非正整数 storyWorkId 由状态机显式抛错，调用方按失败路径处理（不写回）。
 */
export function finishPromotionAsReady(
  promoting: PromotingChatArtifact,
  storyWorkId: number,
): ReadyChatArtifact {
  return markPromotionSuccess(promoting, { storyWorkId });
}

/**
 * 将归属校验通过的 promoting 落为 promotion_failed（promoting → promotion_failed）。
 * 完整 storyText / sourceMessageId / prompt / voice 快照由状态机保留，delivery 不动。
 */
export function finishPromotionAsFailed(
  promoting: PromotingChatArtifact,
  error: unknown,
): PromotionFailedChatArtifact {
  const message = error instanceof Error ? error.message : String(error);
  return markPromotionFailed(promoting, { error: message });
}
