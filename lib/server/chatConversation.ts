/**
 * 聊天会话服务层
 *
 * 单会话快照存取：getConversation 读取按 position 排序的消息；saveConversation 以事务
 * 删旧 + 批量写新（整条替换），parts 以 JSON 存取。
 */

import { prisma } from '@/lib/db';
import type { ChatMessageInput, ChatMessageDTO } from '@/lib/trpc/schemas/chatConversation';

/** ChatMessage 行中本服务关心的字段子集。 */
type ChatMessageRow = {
    messageId: string;
    role: string;
    content: string;
    parts: string | null;
    agentType: string | null;
    createdAt: string | null;
};

/**
 * DB 行 → 前端 DTO（parts JSON 解析，失败则忽略）。
 */
const toDto = (row: ChatMessageRow): ChatMessageDTO => {
    let parts: Array<Record<string, unknown>> | undefined;
    if (row.parts) {
        try {
            const parsed = JSON.parse(row.parts);
            if (Array.isArray(parsed)) {
                parts = parsed as Array<Record<string, unknown>>;
            }
        } catch {
            parts = undefined;
        }
    }
    return {
        messageId: row.messageId,
        role: row.role,
        content: row.content,
        parts,
        agentType: row.agentType ?? undefined,
        createdAt: row.createdAt ?? undefined,
    };
};

/**
 * 读取当前用户的会话消息（按 position 升序）。
 * @param userId 用户 ID。
 */
export const getConversation = async (userId: number): Promise<ChatMessageDTO[]> => {
    const rows = await prisma.chatMessage.findMany({
        where: { userId },
        orderBy: { position: 'asc' },
    });
    return rows.map(toDto);
};

/**
 * 以快照方式整条替换当前用户的会话（删旧 + 批量写新）。空数组即清空。
 * @param userId 用户 ID。
 * @param messages 待保存的消息（已为完成态、已剔除 summary、storyCard 音频已置空）。
 */
export const saveConversation = async (
    userId: number,
    messages: ChatMessageInput[],
): Promise<void> => {
    const deleteOp = prisma.chatMessage.deleteMany({ where: { userId } });

    if (messages.length === 0) {
        await prisma.$transaction([deleteOp]);
        return;
    }

    const createOp = prisma.chatMessage.createMany({
        data: messages.map((message, index) => ({
            userId,
            position: index,
            messageId: message.messageId,
            role: message.role,
            content: message.content,
            parts: message.parts ? JSON.stringify(message.parts) : null,
            agentType: message.agentType ?? null,
            createdAt: message.createdAt ?? null,
        })),
    });

    await prisma.$transaction([deleteOp, createOp]);
};
