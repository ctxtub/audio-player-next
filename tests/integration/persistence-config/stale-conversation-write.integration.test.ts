import assert from 'node:assert';
import { prisma } from '../../../lib/db';
import {
    getConversation,
    saveConversation,
    getConversationForSubject,
    saveConversationForSubject,
} from '../../../lib/server/chatConversation';
import { TRPCError } from '../../../lib/trpc/init';

/**
 * 构造待保存的单条会话消息。
 * @param messageId 合成消息 ID
 * @param content 消息正文
 */
function buildMessage(messageId: string, content: string) {
    return { messageId, role: 'user', content };
}

// 中文注释：H-15 回归——双标签后写整体覆盖必须被拒写而非静默丢增量。
async function runH15Tests(): Promise<void> {
    // 中文注释：写库隔离守卫——绝不触碰 prisma/dev.db 与生产库。
    const dbUrl = process.env.DATABASE_URL ?? '';
    assert.ok(dbUrl, 'DATABASE_URL 必须由运行器注入隔离库');
    assert.ok(
        !dbUrl.includes('dev.db') && !dbUrl.includes('app.db'),
        `拒绝写真实/生产库，DATABASE_URL=${dbUrl.slice(0, 80)}`,
    );
    const stamp = Date.now();
    console.log('=== H-15: stale 快照写必须以 CONFLICT 拒绝 ===');

    // —— 用户主体：双标签并发写 ——
    const username = `h15_user_${stamp}`;
    const user = await prisma.user.create({
        data: { username, password: 'test-hash' },
    });
    try {
        await prisma.chatMessage.deleteMany({ where: { userId: user.id } });
        const m1 = buildMessage(`h15_m1_${stamp}`, 'base');
        await saveConversation(user.id, [m1]);

        const base = await getConversation(user.id);
        const baseIds = base.map((m) => m.messageId);
        assert.deepStrictEqual(baseIds, [m1.messageId], '基线快照应仅含 m1');

        // A 标签基于基线追加 m2 并保存（期望成功）。
        const m2 = buildMessage(`h15_m2_${stamp}`, 'tabA-increment');
        await saveConversation(
            user.id,
            [m1, m2],
            { expectedMessageIds: baseIds } as unknown as Parameters<typeof saveConversation>[2],
        );
        const afterA = await getConversation(user.id);
        assert.deepStrictEqual(
            afterA.map((m) => m.messageId),
            [m1.messageId, m2.messageId],
            'A 标签保存后应为 [m1,m2]',
        );

        // B 标签基于陈旧基线追加 m3（必须以 CONFLICT 拒绝，不静默丢 m2）。
        const m3 = buildMessage(`h15_m3_${stamp}`, 'tabB-stale-increment');
        await assert.rejects(
            saveConversation(
                user.id,
                [m1, m3],
                { expectedMessageIds: baseIds } as unknown as Parameters<typeof saveConversation>[2],
            ),
            (err: unknown) => err instanceof TRPCError && err.code === 'CONFLICT',
            '陈旧基线的快照写必须以 CONFLICT 拒绝',
        );
        const afterStale = await getConversation(user.id);
        assert.deepStrictEqual(
            afterStale.map((m) => m.messageId),
            [m1.messageId, m2.messageId],
            '拒写后库内必须仍为 [m1,m2]，不得丢 A 增量',
        );

        // 持新鲜基线的写应成功。
        const fresh = await getConversation(user.id);
        const m4 = buildMessage(`h15_m4_${stamp}`, 'fresh-increment');
        await saveConversation(
            user.id,
            [...fresh.map((m) => ({ messageId: m.messageId, role: m.role, content: m.content })), m4],
            {
                expectedMessageIds: fresh.map((m) => m.messageId),
            } as unknown as Parameters<typeof saveConversation>[2],
        );
        const afterFresh = await getConversation(user.id);
        assert.ok(
            afterFresh.some((m) => m.messageId === m4.messageId),
            '新鲜基线的写应成功落库 m4',
        );

        // 无基线参数的旧调用保持向后兼容（路由未传版本时仍可写）。
        const m5 = buildMessage(`h15_m5_${stamp}`, 'legacy-write');
        await saveConversation(user.id, [
            ...afterFresh.map((m) => ({ messageId: m.messageId, role: m.role, content: m.content })),
            m5,
        ]);
        const afterLegacy = await getConversation(user.id);
        assert.ok(
            afterLegacy.some((m) => m.messageId === m5.messageId),
            '无 expected 的旧调用应保持可写（向后兼容）',
        );
        console.log('PASS: H-15 用户主体 stale 拒写 + 新鲜可写 + 旧调用兼容');
    } finally {
        await prisma.chatMessage.deleteMany({ where: { userId: user.id } });
        await prisma.user.deleteMany({ where: { id: user.id } });
    }

    // —— 访客主体：陈旧写同样拒写 ——
    console.log('=== H-15: 访客主体 stale 写必须以 CONFLICT 拒绝 ===');
    const guestId = `g_h15_${stamp}`;
    try {
        await prisma.guestChatMessage.deleteMany({ where: { guestId } });
        const subject = { type: 'guest', id: guestId } as const;
        const g1 = buildMessage(`h15_g1_${stamp}`, 'guest-base');
        await saveConversationForSubject(subject, [g1]);

        const gBase = await getConversationForSubject(subject);
        const gBaseIds = gBase.map((m) => m.messageId);

        const g2 = buildMessage(`h15_g2_${stamp}`, 'guest-tabA');
        await saveConversationForSubject(
            subject,
            [g1, g2],
            { expectedMessageIds: gBaseIds } as unknown as Parameters<typeof saveConversationForSubject>[2],
        );

        const g3 = buildMessage(`h15_g3_${stamp}`, 'guest-tabB-stale');
        await assert.rejects(
            saveConversationForSubject(
                subject,
                [g1, g3],
                { expectedMessageIds: gBaseIds } as unknown as Parameters<
                    typeof saveConversationForSubject
                >[2],
            ),
            (err: unknown) => err instanceof TRPCError && err.code === 'CONFLICT',
            '访客陈旧基线的快照写必须以 CONFLICT 拒绝',
        );
        const gAfter = await getConversationForSubject(subject);
        assert.deepStrictEqual(
            gAfter.map((m) => m.messageId),
            [g1.messageId, g2.messageId],
            '访客拒写后库内必须仍为 [g1,g2]',
        );
        console.log('PASS: H-15 访客主体 stale 拒写');
    } finally {
        await prisma.guestChatMessage.deleteMany({ where: { guestId } });
    }

    console.log('ALL H-15 CONCURRENT WRITE TESTS PASSED SUCCESSFULLY');
}

const testPromise = runH15Tests()
    .then(() => {
        console.log('ALL H-15 CONCURRENT WRITE TESTS PASSED SUCCESSFULLY');
    })
    .catch((err) => {
        console.error('H-15 test failed:', err);
        process.exit(1);
    });

export default testPromise;
