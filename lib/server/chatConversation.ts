/**
 * 聊天会话服务层
 *
 * 单会话快照存取：getConversation 读取按 position 排序的消息；saveConversation 以事务
 * 删旧 + 批量写新（整条替换），parts 以 JSON 存取。
 *
 * M4-08 Legacy StoryCard Cutover（只读切换 / 新写封禁）：
 * Modern runtime 只产 storyArtifact；已持久化的 storyCard 可继续 decode/render/play/read
 * 并随快照原样续存（compatibility preservation），但服务端以 persisted provenance 为依据，
 * 永久拒绝任何此前不存在、被篡改或被复制扩增的 StoryCard（legacy origination）。
 * 关系：Incoming legacy set ⊆ previously persisted legacy set（multiset subset）。
 */

import { prisma } from '@/lib/db';
import { TRPCError } from '@/lib/trpc/init';
import type { ChatMessageInput, ChatMessageDTO } from '@/lib/trpc/schemas/chatConversation';

/**
 * 快照保存的乐观并发选项：调用方传入读取快照时的基线 messageId 序列。
 * 提供即启用 stale-write 拒绝；缺省保持旧行为（向后兼容路由旧调用）。
 */
export type ConversationSaveOptions = {
    expectedMessageIds?: string[];
};

/**
 * 断言库内现状与调用方基线一致，不一致则抛 CONFLICT 拒绝静默覆盖。
 * @param currentIds 库内当前按 position 排序的 messageId 序列。
 * @param expected 调用方读取快照时的基线序列（undefined 表示不校验）。
 */
const assertFreshBaseline = (currentIds: string[], expected: string[] | undefined): void => {
    if (expected === undefined) {
        return;
    }
    const stale =
        currentIds.length !== expected.length ||
        currentIds.some((id, index) => id !== expected[index]);
    if (stale) {
        throw new TRPCError({
            code: 'CONFLICT',
            message: '会话已被其它标签页更新，本次写入已拒绝，请刷新后重试',
        });
    }
};

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
 * M4-08 Legacy provenance guard 的拒绝文案（内部错误描述，不构成公共 API 契约；
 * 调用方仅依赖错误码：BAD_REQUEST 表示 Legacy 新写，CONFLICT 表示基线 stale）。
 */
const LEGACY_CUTOVER_REJECT_MESSAGE =
    'Legacy StoryCard 新写已被禁止（M4-08 cutover：只允许原样续存既有历史）';

/** Legacy fingerprint 内 messageId 与 storyText 的分隔符（storyText 可含任意字符，取 \0 避免碰撞）。 */
const LEGACY_FINGERPRINT_SEPARATOR = '\u0000';

/** Provenance 比较的最小输入形态（DB 行的 parts 为 JSON 字符串；incoming 为已解析数组）。 */
type LegacyProvenanceEntry = {
    readonly messageId: string;
    readonly parts?: unknown;
};

/**
 * 收集消息集合中的 Legacy StoryCard fingerprint 计数（multiset）。
 * fingerprint = messageId + storyText + occurrence count；audioUrl 显式不参与
 * （audioUrl 是非持久字段：M4-06 起 save 侧统一置空，新旧 ''/temp-url 视为同一张卡）。
 * 非 storyCard part 一律忽略；storyText 非字符串时按其 JSON 形态计入（仍受 subset 约束）。
 * @param messages 待统计的消息集合（DB 行或 incoming 快照均可）。
 * @returns fingerprint → 出现次数。
 */
const collectLegacyFingerprintCounts = (
    messages: ReadonlyArray<LegacyProvenanceEntry>,
): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const message of messages) {
        if (message === null || typeof message !== 'object') {
            continue;
        }
        if (typeof message.messageId !== 'string' || message.messageId === '') {
            continue;
        }
        let parts: unknown = message.parts;
        if (typeof parts === 'string') {
            try {
                parts = JSON.parse(parts) as unknown;
            } catch {
                continue;
            }
        }
        if (!Array.isArray(parts)) {
            continue;
        }
        for (const part of parts) {
            if (part === null || typeof part !== 'object') {
                continue;
            }
            const record = part as Record<string, unknown>;
            if (record.type !== 'storyCard') {
                continue;
            }
            const storyText =
                typeof record.storyText === 'string'
                    ? record.storyText
                    : JSON.stringify(record.storyText ?? null);
            const key = `${message.messageId}${LEGACY_FINGERPRINT_SEPARATOR}${storyText}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    return counts;
};

/**
 * M4-08 Legacy provenance guard（纯函数，无副作用，不读库不写库）。
 *
 * 断言 incoming 快照中的 Legacy StoryCard multiset 是已持久化集合的子集：
 * 允许删除 Legacy（incoming 为空或减少）、允许原样保留（含 audioUrl ''/temp 差异）；
 * 禁止引入（新 messageId 带卡）、禁止复制扩增（同卡 count 变大）、禁止改造
 * （同 messageId 下 storyText 变化视为新卡）。
 *
 * @param currentRows 事务内读取的当前 DB 行（含 messageId + parts JSON）。
 * @param incomingMessages 本次待保存的快照。
 * @throws TRPCError code BAD_REQUEST（Legacy origination；绝不抛 CONFLICT）。
 */
export const assertNoNewLegacyStoryCardWrites = (
    currentRows: ReadonlyArray<{ readonly messageId: string; readonly parts: string | null }>,
    incomingMessages: ReadonlyArray<LegacyProvenanceEntry>,
): void => {
    const persisted = collectLegacyFingerprintCounts(currentRows);
    const incoming = collectLegacyFingerprintCounts(incomingMessages);
    for (const [key, count] of incoming) {
        const allowed = persisted.get(key) ?? 0;
        if (count > allowed) {
            const separatorIndex = key.indexOf(LEGACY_FINGERPRINT_SEPARATOR);
            const messageId = separatorIndex >= 0 ? key.slice(0, separatorIndex) : key;
            throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `${LEGACY_CUTOVER_REJECT_MESSAGE}（messageId=${messageId}）`,
            });
        }
    }
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
 * 提供 expectedMessageIds 时启用 stale-write 拒绝：库内现状与基线不一致即抛 CONFLICT。
 * M4-08：Legacy provenance guard 恒为 always-on（即使不传 options 也执行）；
 * 顺序冻结：load current → assertFreshBaseline → assertNoNewLegacyStoryCardWrites → replace，
 * stale baseline + 非法 legacy 仍先报 CONFLICT；写入时 Legacy audioUrl 统一 sanitize 为 ''。
 * @param userId 用户 ID。
 * @param messages 待保存的消息（已为完成态、已剔除 summary、storyCard 音频已置空）。
 * @param options 乐观并发选项（可选，不传保持旧行为；仅影响基线校验，不影响 cutover guard）。
 */
export const saveConversation = async (
    userId: number,
    messages: ChatMessageInput[],
    options?: ConversationSaveOptions,
): Promise<void> => {
    await prisma.$transaction(async (tx) => {
        // M4-08：guard 必须在 deleteMany 之前、与 replace 同一事务内完成；为此恒读基线行。
        const current = await tx.chatMessage.findMany({
            where: { userId },
            orderBy: { position: 'asc' },
            select: { messageId: true, parts: true },
        });
        assertFreshBaseline(
            current.map((row) => row.messageId),
            options?.expectedMessageIds,
        );
        assertNoNewLegacyStoryCardWrites(current, messages);

        await tx.chatMessage.deleteMany({ where: { userId } });

        if (messages.length === 0) {
            return;
        }

        await tx.chatMessage.createMany({
            data: messages.map((message, index) => ({
                userId,
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
};

import type { Subject } from './subject';

const GUEST_CHAT_KEEP_LIMIT = 100;

/**
 * 确保 parts 内所有 storyCard 的 audioUrl 均置空（不存音频二进制或临时 URL）。
 * M4-08：user / guest 两条保存路径语义收口，共用同一 sanitize（sanitize ≠ create，
 * 绝不据 content 构造新卡，仅对已存在的 Legacy 卡做 audioUrl 归一）。
 */
const sanitizePartsForWrite = (parts?: Array<Record<string, unknown>>): string | null => {
    if (!parts) return null;
    const cleaned = parts.map((p) => {
        if (p && typeof p === 'object' && p.type === 'storyCard') {
            return { ...p, audioUrl: '' };
        }
        return p;
    });
    return JSON.stringify(cleaned);
};

/**
 * 读取当前主体（用户或具名访客）的会话消息（按 position 升序）。
 */
export const getConversationForSubject = async (
    subject: Subject
): Promise<ChatMessageDTO[]> => {
    if (subject.type === 'user') {
        return getConversation(subject.id);
    }
    const rows = await prisma.guestChatMessage.findMany({
        where: { guestId: subject.id },
        orderBy: { position: 'asc' },
    });
    return rows.map(toDto);
};

/**
 * 以快照方式整条替换当前主体（用户或具名访客）的会话。
 * 访客限制最多保留最近 GUEST_CHAT_KEEP_LIMIT 条。
 * 提供 expectedMessageIds 时同样启用 stale-write 拒绝。
 * M4-08：与 user 路径共用同一 Legacy provenance guard（always-on）与同一
 * sanitize 语义；顺序冻结：load current → baseline → provenance → replace。
 */
export const saveConversationForSubject = async (
    subject: Subject,
    messages: ChatMessageInput[],
    options?: ConversationSaveOptions,
): Promise<void> => {
    if (subject.type === 'user') {
        return saveConversation(subject.id, messages, options);
    }

    const cappedMessages = messages.length > GUEST_CHAT_KEEP_LIMIT
        ? messages.slice(-GUEST_CHAT_KEEP_LIMIT)
        : messages;

    await prisma.$transaction(async (tx) => {
        // M4-08：guard 必须在 deleteMany 之前、与 replace 同一事务内完成；为此恒读基线行。
        const current = await tx.guestChatMessage.findMany({
            where: { guestId: subject.id },
            orderBy: { position: 'asc' },
            select: { messageId: true, parts: true },
        });
        assertFreshBaseline(
            current.map((row) => row.messageId),
            options?.expectedMessageIds,
        );
        assertNoNewLegacyStoryCardWrites(current, cappedMessages);

        await tx.guestChatMessage.deleteMany({ where: { guestId: subject.id } });

        if (cappedMessages.length === 0) {
            return;
        }

        await tx.guestChatMessage.createMany({
            data: cappedMessages.map((message, index) => ({
                guestId: subject.id,
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
};
