/**
 * M5-09 fixup：Draft rehydrate canonical resolver（评审 Blocking 1）。
 *
 * Chat domain / compatibility 层唯一 canonical 入口：Chat 消息按 messageId
 * 解析为 Draft 快照（storyText + 可选 title/voiceId/contentHash）。
 *
 * 优先级冻结（Modern-first）：
 * 1. Modern StoryArtifact first：经既有 M4 校验面 rehydrateStoryArtifactPart
 *    严格校验 + 进程边界降级，首个正文非空者胜；
 * 2. Legacy 历史卡 fallback：经 chatStoryCompatibility 现有 reader
 *   （decodeLegacyStoryCard）只读兼容，首个合法者胜，不新写不转换；
 * 3. 两者皆无 → null（调用方按 dangling fail-closed 清 Anchor）。
 *
 * fail-closed：任何非法输入（缺消息、非 delivered、空 parts、校验失败、
 * 空正文、异常）一律 null，不抛。
 *
 * M4 边界：本模块是 Chat domain 薄适配（读 ChatStore + 调两大既有校验面），
 * 自身不重新理解 wire 结构（不做字面量分支），不做 promotion/library/create、
 * 不写 History、不碰 playback transport/server/Prisma。
 */

import type { ChatMessage } from '../../types/chat';
import { decodeLegacyStoryCard } from './chatStoryCompatibility';
import { rehydrateStoryArtifactPart } from './chatArtifactHistory';
import { useChatStore } from '@/stores/chatStore';

/** Draft 快照（rehydrate 消费面；contentHash 由调用方经 segmentation SSOT 计算，此处可选透传）。 */
export interface PlaybackDraftSnapshot {
  readonly storyText: string;
  readonly title?: string;
  readonly voiceId?: string;
  readonly contentHash?: string;
}

function isUsableStoryText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() !== '';
}

function pickOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return value;
}

/**
 * 纯函数：由单条 ChatMessage 解析 Draft 快照（Modern first → Legacy fallback）。
 * @param message 待解析消息（undefined/null 一律 null）。
 * @returns 快照或 null。
 */
export function resolveDraftSnapshotFromMessage(
  message: ChatMessage | undefined | null,
): PlaybackDraftSnapshot | null {
  if (!message || typeof message !== 'object') return null;
  if (message.status !== undefined && message.status !== 'delivered') return null;
  const parts = message.parts;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const messageId = message.id;
  if (typeof messageId !== 'string' || messageId.trim() === '') return null;
  const messageRole = message.role;

  // —— Modern first：经 M4 校验面逐个校验，首个正文可用者胜 ——
  for (const raw of parts) {
    let recovered: { artifact?: Record<string, unknown> } | null = null;
    try {
      recovered = rehydrateStoryArtifactPart(raw, {
        messageId,
        messageRole: String(messageRole),
      }) as unknown as { artifact?: Record<string, unknown> } | null;
    } catch {
      continue;
    }
    if (!recovered || typeof recovered !== 'object') continue;
    const artifact = (recovered as { artifact?: unknown }).artifact as
      | Record<string, unknown>
      | undefined;
    if (!artifact || typeof artifact !== 'object') continue;
    if (!isUsableStoryText(artifact.storyText)) continue;
    const title = pickOptionalString(artifact.title);
    const voiceId = pickOptionalString(artifact.voiceId);
    const contentHash = pickOptionalString(artifact.contentHash);
    return {
      storyText: artifact.storyText as string,
      ...(title !== undefined ? { title } : null),
      ...(voiceId !== undefined ? { voiceId } : null),
      ...(contentHash !== undefined ? { contentHash } : null),
    };
  }

  // —— Legacy fallback：经既有 compatibility reader 只读，首个合法者胜 ——
  for (const raw of parts) {
    let card: { storyText?: unknown } | null = null;
    try {
      card = decodeLegacyStoryCard(raw) as unknown as { storyText?: unknown } | null;
    } catch {
      continue;
    }
    if (!card || typeof card !== 'object') continue;
    if (!isUsableStoryText(card.storyText)) continue;
    return { storyText: card.storyText as string };
  }

  return null;
}

/**
 * 纯函数：由消息列表按 messageId 解析（供测试注入与 store 复用，不读全局 store）。
 * @param messages 消息列表。
 * @param messageId 目标 assistant 消息 id。
 * @returns 快照或 null。
 */
export function resolvePlaybackDraftSnapshotFromMessages(
  messages: readonly ChatMessage[] | undefined | null,
  messageId: string,
): PlaybackDraftSnapshot | null {
  if (typeof messageId !== 'string' || messageId.trim() === '') return null;
  if (!Array.isArray(messages)) return null;
  const found = (messages as readonly ChatMessage[]).find(
    (m) => m != null && (m as ChatMessage).id === messageId,
  ) as ChatMessage | undefined;
  if (!found) return null;
  return resolveDraftSnapshotFromMessage(found);
}

/**
 * Canonical resolver：messageId → snapshot | null（读 ChatStore 运行时态）。
 * fail-closed：任何异常一律 null。
 * @param messageId Draft Anchor 指向的 assistant 消息 id。
 * @returns 快照或 null（null = dangling，调用方清 Anchor）。
 */
export function resolvePlaybackDraftSnapshot(messageId: string): PlaybackDraftSnapshot | null {
  try {
    if (typeof messageId !== 'string' || messageId.trim() === '') return null;
    const messages = useChatStore.getState().messages;
    return resolvePlaybackDraftSnapshotFromMessages(messages, messageId);
  } catch {
    return null;
  }
}
