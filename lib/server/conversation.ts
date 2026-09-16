/**
 * Conversation 服务层（change-id 2026-09-15-story-collection-continuous-creation）。
 *
 * 会话是创作上下文，一个 Conversation 至多一个 StoryCollection（产品 §1 约束 1）。
 * 本服务提供 getActive / get / createNew / saveSnapshot / close，User / Guest 严格对称。
 *
 * 关键约束：
 * - 一主体至多一个 active Conversation：服务事务 + DB 部分唯一索引双保险；
 * - createNew(expectedOldId) 关闭旧 active 并创建新 UUID，绝不删除旧 Collection；
 * - saveSnapshot 仅替换目标会话的消息，不跨会话删除（区别于 legacy 全量替换路径）；
 * - 所有读写从 Subject 进入，跨主体统一 NOT_FOUND（fail closed）。
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { TRPCError } from '@trpc/server';
import type { Subject } from './subject';
import type { ChatMessageInput, ChatMessageDTO } from '@/lib/trpc/schemas/chatConversation';
import type { ConversationDTO } from '@/lib/trpc/schemas/conversation';
import {
  assertFreshBaseline,
  assertNoNewLegacyStoryCardWrites,
  sanitizePartsForWrite,
  toChatMessageDto,
} from './chatConversation';

/** 访客单会话快照保留上限（与 legacy chat 一致） */
const GUEST_CHAT_KEEP_LIMIT = 100;

type ConversationRow = {
  id: string;
  state: string;
  createdAt: Date;
  updatedAt: Date;
  collections?: Array<{ id: string }>;
};

/** DB 行 → 会话 DTO（collectionId 取 1:1 集合）。 */
export const toConversationDto = (row: ConversationRow): ConversationDTO => ({
  id: row.id,
  state: row.state === 'closed' ? 'closed' : 'active',
  collectionId: row.collections && row.collections.length > 0 ? row.collections[0].id : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * 读取当前主体（用户或具名访客）的 active 会话。
 * @param subject 身份主体
 * @returns active 会话 DTO 或 null
 */
export async function getActiveConversationForSubject(
  subject: Subject,
): Promise<ConversationDTO | null> {
  if (subject.type === 'user') {
    const row = await prisma.conversation.findFirst({
      where: { userId: subject.id, state: 'active' },
      include: { collections: { select: { id: true }, take: 1 } },
    });
    return row ? toConversationDto(row) : null;
  }
  const row = await prisma.guestConversation.findFirst({
    where: { guestId: subject.id, state: 'active' },
    include: { collections: { select: { id: true }, take: 1 } },
  });
  return row ? toConversationDto(row) : null;
}

/**
 * 读取当前主体拥有的指定会话（active 或 closed 均可）。
 * 不存在 / 跨主体统一 NOT_FOUND。
 */
export async function getConversationForSubject(
  subject: Subject,
  id: string,
): Promise<ConversationDTO> {
  const row = await findOwnedConversation(subject, id);
  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: '会话不存在' });
  }
  return toConversationDto(row);
}

/**
 * 读取指定会话的消息（仅本会话，按 position 升序）。
 *
 *：Chat 读路径的会话级实现——先断言会话归属（跨主体 NOT_FOUND，fail closed），
 * 再按 `conversationId` 过滤，绝不返回其它会话的消息。
 *
 * @param subject 身份主体
 * @param conversationId 目标会话 id
 * @returns 该会话的 ChatMessageDTO 列表
 */
export async function getConversationMessagesForSubject(
  subject: Subject,
  conversationId: string,
): Promise<ChatMessageDTO[]> {
  await assertConversationOwned(subject, conversationId);
  if (subject.type === 'user') {
    const rows = await prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { position: 'asc' },
    });
    return rows.map(toChatMessageDto);
  }
  const rows = await prisma.guestChatMessage.findMany({
    where: { conversationId },
    orderBy: { position: 'asc' },
  });
  return rows.map(toChatMessageDto);
}

/**
 * 校验会话归属并返回行；供 promotion / snapshot 复用。
 */
export async function findOwnedConversation(
  subject: Subject,
  id: string,
): Promise<ConversationRow | null> {
  if (typeof id !== 'string' || id.length === 0) return null;
  if (subject.type === 'user') {
    return prisma.conversation.findFirst({
      where: { id, userId: subject.id },
      include: { collections: { select: { id: true }, take: 1 } },
    });
  }
  return prisma.guestConversation.findFirst({
    where: { id, guestId: subject.id },
    include: { collections: { select: { id: true }, take: 1 } },
  });
}

/**
 * 断言会话归属（不存在即 NOT_FOUND）。
 */
export async function assertConversationOwned(
  subject: Subject,
  id: string,
): Promise<ConversationRow> {
  const row = await findOwnedConversation(subject, id);
  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: '会话不存在' });
  }
  return row;
}

/**
 * 新建创作：关闭当前 active 会话并创建新会话（不删除旧 Collection，产品 §3.2）。
 *
 * @param subject 身份主体
 * @param expectedOldId 客户端已知的旧 active 会话；不匹配即 CONFLICT（多标签页并发保护）
 * @returns 新 active 会话 DTO
 */
export async function createNewConversationForSubject(
  subject: Subject,
  expectedOldId?: string,
): Promise<ConversationDTO> {
  const newId = randomUUID();

  const run = async (): Promise<ConversationDTO> => {
    return prisma.$transaction(async (tx) => {
      if (subject.type === 'user') {
        const active = await tx.conversation.findFirst({
          where: { userId: subject.id, state: 'active' },
          orderBy: { createdAt: 'desc' },
          include: { collections: { select: { id: true }, take: 1 } },
        });
        if (expectedOldId !== undefined && (active?.id ?? null) !== expectedOldId) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: '会话已变化，新建创作被拒绝，请刷新后重试',
          });
        }
        if (active) {
          await tx.conversation.update({ where: { id: active.id }, data: { state: 'closed' } });
        }
        const created = await tx.conversation.create({
          data: { id: newId, userId: subject.id, state: 'active' },
        });
        return toConversationDto(created);
      }

      const active = await tx.guestConversation.findFirst({
        where: { guestId: subject.id, state: 'active' },
        orderBy: { createdAt: 'desc' },
        include: { collections: { select: { id: true }, take: 1 } },
      });
      if (expectedOldId !== undefined && (active?.id ?? null) !== expectedOldId) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: '会话已变化，新建创作被拒绝，请刷新后重试',
        });
      }
      if (active) {
        await tx.guestConversation.update({ where: { id: active.id }, data: { state: 'closed' } });
      }
      const created = await tx.guestConversation.create({
        data: { id: newId, guestId: subject.id, state: 'active' },
      });
      return toConversationDto(created);
    });
  };

  try {
    return await run();
  } catch (error) {
    // 并发 createNew 触发部分唯一索引（一主体一 active）：收敛为 CONFLICT，不静默产出双 active。
    if (isUniqueViolation(error)) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: '会话已变化，新建创作被拒绝，请刷新后重试',
      });
    }
    throw error;
  }
}

/**
 * 关闭指定会话（幂等）；不存在 / 跨主体 NOT_FOUND。
 */
export async function closeConversationForSubject(
  subject: Subject,
  id: string,
): Promise<ConversationDTO> {
  const existing = await assertConversationOwned(subject, id);
  if (existing.state !== 'closed') {
    if (subject.type === 'user') {
      await prisma.conversation.updateMany({
        where: { id, userId: subject.id },
        data: { state: 'closed' },
      });
    } else {
      await prisma.guestConversation.updateMany({
        where: { id, guestId: subject.id },
        data: { state: 'closed' },
      });
    }
  }
  return getConversationForSubject(subject, id);
}

/**
 * 以快照方式替换指定会话的消息（仅本会话，不跨会话删除）。
 *
 * 顺序冻结：load current(conversationId) → baseline → legacy provenance → replace。
 * User / Guest 对称；Guest 保留最近 GUEST_CHAT_KEEP_LIMIT 条。
 */
export async function saveConversationSnapshotForSubject(
  subject: Subject,
  conversationId: string,
  messages: ChatMessageInput[],
  options?: { expectedMessageIds?: string[] },
): Promise<void> {
  await assertConversationOwned(subject, conversationId);

  const capped =
    subject.type === 'guest' && messages.length > GUEST_CHAT_KEEP_LIMIT
      ? messages.slice(-GUEST_CHAT_KEEP_LIMIT)
      : messages;

  if (subject.type === 'user') {
    await prisma.$transaction(async (tx) => {
      const current = await tx.chatMessage.findMany({
        where: { conversationId },
        orderBy: { position: 'asc' },
        select: { messageId: true, parts: true },
      });
      assertFreshBaseline(current.map((r) => r.messageId), options?.expectedMessageIds);
      assertNoNewLegacyStoryCardWrites(current, capped);
      await tx.chatMessage.deleteMany({ where: { conversationId } });
      if (capped.length === 0) return;
      await tx.chatMessage.createMany({
        data: capped.map((message, index) => ({
          userId: subject.id,
          conversationId,
          position: index,
          messageId: message.messageId,
          role: message.role,
          content: message.content,
          parts: sanitizePartsForWrite(message.parts),
          agentType: message.agentType ?? null,
          createdAt: message.createdAt ?? null,
        })),
      });
    });
    return;
  }

  await prisma.$transaction(async (tx) => {
    const current = await tx.guestChatMessage.findMany({
      where: { conversationId },
      orderBy: { position: 'asc' },
      select: { messageId: true, parts: true },
    });
    assertFreshBaseline(current.map((r) => r.messageId), options?.expectedMessageIds);
    assertNoNewLegacyStoryCardWrites(current, capped);
    await tx.guestChatMessage.deleteMany({ where: { conversationId } });
    if (capped.length === 0) return;
    await tx.guestChatMessage.createMany({
      data: capped.map((message, index) => ({
        guestId: subject.id,
        conversationId,
        position: index,
        messageId: message.messageId,
        role: message.role,
        content: message.content,
        parts: sanitizePartsForWrite(message.parts),
        agentType: message.agentType ?? null,
        createdAt: message.createdAt ?? null,
      })),
    });
  });
}

/** Prisma 唯一约束冲突判定（P2002）。 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}
