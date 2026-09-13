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
 * M4-08 Legacy StoryCard Cutover 服务端 provenance guard 回归（E2E-08-08）。
 *
 * 契约：Incoming legacy set ⊆ previously persisted legacy set（multiset subset，
 * fingerprint = messageId + storyText + occurrence count，不含 audioUrl）。
 * 允许删除/原样保留；禁止引入、复制扩增、改造；guard always-on（无 baseline 也执行）；
 * 顺序冻结 load → baseline(CONFLICT) → provenance(BAD_REQUEST) → replace；
 * user / guest 共用同一 helper、对称生效；写入统一 sanitize audioUrl → ''。
 *
 * 为模拟“M4-08 之前已持久化的历史”，旧 Legacy 行经 prisma 直接 seeding（有意绕过
 * 被测 guard——guard 本身正是要禁止经 save 路径新建 Legacy，种子只能直写）。
 */

type Subject = { type: 'user'; id: number } | { type: 'guest'; id: string };

const storyCard = (storyText: string, audioUrl = '') => ({
    type: 'storyCard',
    storyText,
    audioUrl,
});

const storyArtifactMsg = (messageId: string, storyText = '现代正文') => ({
    messageId,
    role: 'assistant',
    content: storyText,
    parts: [
        {
            type: 'storyArtifact',
            artifact: {
                id: `artifact-${messageId}`,
                artifactType: 'story',
                status: 'ready',
                sourceMessageId: messageId,
                storyText,
                title: '测试标题',
                prompt: '测试 prompt',
                storyWorkId: 999,
                createdAt: '2026-09-12T00:00:00.000Z',
                updatedAt: '2026-09-12T00:00:01.000Z',
            },
        },
    ],
});

const snapshotOf = async (subject: Subject) => {
    const rows =
        subject.type === 'user'
            ? await getConversation(subject.id)
            : await getConversationForSubject(subject);
    return rows.map((m) => ({ messageId: m.messageId, content: m.content, parts: m.parts ?? null }));
};

const saveFor = (
    subject: Subject,
    messages: Array<Record<string, unknown>>,
    options?: { expectedMessageIds?: string[] },
    // 中文注释：ChatMessageInput 为宽松结构，此处以 Record 构造后 cast，避免重复声明。
): Promise<void> =>
    subject.type === 'user'
        ? saveConversation(
              subject.id,
              messages as never,
              options as never,
          )
        : saveConversationForSubject(
              subject,
              messages as never,
              options as never,
          );

/**
 * 直接 seeding 旧 Legacy 行（pre-M4-08 persisted history 模拟，有意绕过 guard）。
 */
const seedDirect = async (
    subject: Subject,
    rows: Array<{ messageId: string; role?: string; content?: string; parts?: unknown }>,
): Promise<void> => {
    if (subject.type === 'user') {
        await prisma.chatMessage.deleteMany({ where: { userId: subject.id } });
        if (rows.length === 0) return;
        await prisma.chatMessage.createMany({
            data: rows.map((r, index) => ({
                userId: subject.id,
                position: index,
                messageId: r.messageId,
                role: r.role ?? 'assistant',
                content: r.content ?? r.messageId,
                parts: r.parts === undefined ? null : JSON.stringify(r.parts),
            })),
        });
        return;
    }
    await prisma.guestChatMessage.deleteMany({ where: { guestId: subject.id } });
    if (rows.length === 0) return;
    await prisma.guestChatMessage.createMany({
        data: rows.map((r, index) => ({
            guestId: subject.id,
            position: index,
            messageId: r.messageId,
            role: r.role ?? 'assistant',
            content: r.content ?? r.messageId,
            parts: r.parts === undefined ? null : JSON.stringify(r.parts),
        })),
    });
};

const clearSubject = async (subject: Subject): Promise<void> => {
    if (subject.type === 'user') {
        await prisma.chatMessage.deleteMany({ where: { userId: subject.id } });
    } else {
        await prisma.guestChatMessage.deleteMany({ where: { guestId: subject.id } });
    }
};

const expectBadRequest = async (fn: () => Promise<unknown>, label: string): Promise<void> => {
    await assert.rejects(
        fn,
        (err: unknown) => {
            assert.ok(err instanceof TRPCError, `${label}：必须为 TRPCError`);
            assert.strictEqual((err as TRPCError).code, 'BAD_REQUEST', `${label}：必须为 BAD_REQUEST（不得为 CONFLICT）`);
            return true;
        },
        label,
    );
};

async function runLegacyCutoverTests(): Promise<void> {
    const dbUrl = process.env.DATABASE_URL ?? '';
    assert.ok(dbUrl, 'DATABASE_URL 必须由运行器注入隔离库');
    assert.ok(
        !dbUrl.includes('dev.db') && !dbUrl.includes('app.db'),
        `拒绝写真实/生产库，DATABASE_URL=${dbUrl.slice(0, 80)}`,
    );
    const stamp = Date.now();
    const username = `cutover_user_${stamp}`;
    const user = await prisma.user.create({
        data: { username, password: 'test-hash' },
    });
    const userSubject: Subject = { type: 'user', id: user.id };

    try {
        console.log('=== M4-08-05: Existing Legacy may round-trip（user + guest） ===');
        for (const [tag, subject] of [
            ['user', userSubject],
            ['guest', { type: 'guest', id: `g_cutover05_${stamp}` } as Subject],
        ] as Array<[string, Subject]>) {
            await seedDirect(subject, [
                {
                    messageId: 'old-1',
                    role: 'assistant',
                    content: 'legacy',
                    parts: [storyCard('legacy', 'https://temporary/old-url')],
                },
            ]);
            await saveFor(subject, [
                { messageId: 'old-1', role: 'assistant', content: 'legacy', parts: [storyCard('legacy', '')] },
                storyArtifactMsg('new-modern-1'),
            ]);
            const after = await snapshotOf(subject);
            assert.strictEqual(after.length, 2, `[${tag}] round-trip 后应为 2 条`);
            const old = after.find((m) => m.messageId === 'old-1');
            assert.ok(old, `[${tag}] old-1 必须保留`);
            assert.strictEqual((old.parts as Array<Record<string, unknown>>)[0].type, 'storyCard', `[${tag}] old-1 仍是 storyCard`);
            assert.strictEqual(
                (old.parts as Array<Record<string, unknown>>)[0].storyText,
                'legacy',
                `[${tag}] storyText 不变得`,
            );
            const modern = after.find((m) => m.messageId === 'new-modern-1');
            assert.strictEqual(
                (modern?.parts as Array<Record<string, unknown>>)[0].type,
                'storyArtifact',
                `[${tag}] Modern 仍是 storyArtifact`,
            );
            await clearSubject(subject);
        }
        console.log('PASS: M4-08-05 round-trip user+guest');

        console.log('=== M4-08-06: New Legacy origination rejected（user + guest，DB unchanged） ===');
        for (const [tag, subject] of [
            ['user', userSubject],
            ['guest', { type: 'guest', id: `g_cutover06_${stamp}` } as Subject],
        ] as Array<[string, Subject]>) {
            await clearSubject(subject);
            const before = await snapshotOf(subject);
            assert.strictEqual(before.length, 0, `[${tag}] 前置应为空`);
            await expectBadRequest(
                () =>
                    saveFor(subject, [
                        { messageId: 'new-legacy', role: 'assistant', content: 'NEW', parts: [storyCard('NEW', '')] },
                    ]),
                `[${tag}] 无中生有 storyCard 必须拒绝`,
            );
            const after = await snapshotOf(subject);
            assert.deepStrictEqual(after, before, `[${tag}] 拒写后 DB snapshot 必须完全未变化`);
            await clearSubject(subject);
        }
        console.log('PASS: M4-08-06 origination rejected');

        console.log('=== M4-08-07: Legacy mutation / duplication rejected，deletion allowed（multiset subset） ===');
        {
            await seedDirect(userSubject, [
                { messageId: 'A', role: 'assistant', content: 'OLD', parts: [storyCard('OLD', '')] },
            ]);
            const baseline = await snapshotOf(userSubject);
            // 改造：同 messageId 正文变化 → 拒绝。
            await expectBadRequest(
                () =>
                    saveFor(userSubject, [
                        { messageId: 'A', role: 'assistant', content: 'NEW', parts: [storyCard('NEW', '')] },
                    ]),
                'storyText 篡改必须拒绝',
            );
            assert.deepStrictEqual(await snapshotOf(userSubject), baseline, '篡改拒写后 DB 不变得');
            // 复制扩增：同卡 1 → 2 → 拒绝。
            await expectBadRequest(
                () =>
                    saveFor(userSubject, [
                        { messageId: 'A', role: 'assistant', content: 'OLD', parts: [storyCard('OLD', ''), storyCard('OLD', '')] },
                    ]),
                '同卡复制扩增必须拒绝',
            );
            assert.deepStrictEqual(await snapshotOf(userSubject), baseline, '扩增拒写后 DB 不变得');
            // 跨消息复制：C 拿旧正文 → 拒绝（messageId 参与 fingerprint）。
            await expectBadRequest(
                () =>
                    saveFor(userSubject, [
                        { messageId: 'A', role: 'assistant', content: 'OLD', parts: [storyCard('OLD', '')] },
                        { messageId: 'C', role: 'assistant', content: 'OLD', parts: [storyCard('OLD', '')] },
                    ]),
                '跨消息复制旧卡必须拒绝',
            );
            assert.deepStrictEqual(await snapshotOf(userSubject), baseline, '复制拒写后 DB 不变得');
            // 删除：A 去卡（0 张）→ 允许。
            await saveFor(userSubject, [{ messageId: 'A', role: 'assistant', content: 'OLD' }]);
            const afterDelete = await snapshotOf(userSubject);
            assert.strictEqual(afterDelete.length, 1, '删除后消息仍在');
            assert.strictEqual(afterDelete[0].parts, null, '卡片可消失（0 张允许）');
            // 多消息 multiset：A foo×1 + B bar×2，部分删除允许、精确保留允许。
            await seedDirect(userSubject, [
                { messageId: 'A', role: 'assistant', content: 'foo', parts: [storyCard('foo', '')] },
                {
                    messageId: 'B',
                    role: 'assistant',
                    content: 'bar',
                    parts: [storyCard('bar', ''), storyCard('bar', '')],
                },
            ]);
            await saveFor(userSubject, [
                { messageId: 'A', role: 'assistant', content: 'foo', parts: [storyCard('foo', '')] },
                { messageId: 'B', role: 'assistant', content: 'bar', parts: [storyCard('bar', '')] },
            ]);
            const partial = await snapshotOf(userSubject);
            assert.strictEqual(
                (partial.find((m) => m.messageId === 'B')?.parts as Array<unknown>).length,
                1,
                'B bar 2→1（删除一张）必须允许',
            );
            await clearSubject(userSubject);
        }
        console.log('PASS: M4-08-07 multiset subset');

        console.log('=== M4-08-08: Legacy audio persistence normalization（user + guest） ===');
        for (const [tag, subject] of [
            ['user', userSubject],
            ['guest', { type: 'guest', id: `g_cutover08_${stamp}` } as Subject],
        ] as Array<[string, Subject]>) {
            await seedDirect(subject, [
                {
                    messageId: 'old-audio',
                    role: 'assistant',
                    content: 'audio-legacy',
                    parts: [storyCard('audio-legacy', 'https://temporary/old-temp-url')],
                },
            ]);
            // 现代客户端续存 audioUrl=''：必须视为同一张卡，保存成功。
            await saveFor(subject, [
                { messageId: 'old-audio', role: 'assistant', content: 'audio-legacy', parts: [storyCard('audio-legacy', '')] },
            ]);
            const raw =
                subject.type === 'user'
                    ? await prisma.chatMessage.findFirst({ where: { userId: subject.id, messageId: 'old-audio' } })
                    : await prisma.guestChatMessage.findFirst({ where: { guestId: subject.id, messageId: 'old-audio' } });
            assert.ok(raw, `[${tag}] 行必须存在`);
            const persistedParts = JSON.parse((raw.parts as string) || '[]') as Array<Record<string, unknown>>;
            assert.strictEqual(persistedParts[0].type, 'storyCard', `[${tag}] 仍是 storyCard`);
            assert.strictEqual(persistedParts[0].audioUrl, '', `[${tag}] DB 写入 audioUrl 必须为 ''`);
            assert.strictEqual(persistedParts[0].storyText, 'audio-legacy', `[${tag}] 正文不变得`);
            await clearSubject(subject);
        }
        console.log('PASS: M4-08-08 audio normalization');

        console.log('=== M4-08-09: No-baseline writer still blocked ===');
        {
            await clearSubject(userSubject);
            await expectBadRequest(
                () =>
                    saveConversation(userSubject.id, [
                        { messageId: 'sneaky', role: 'assistant', content: 'NEW', parts: [storyCard('NEW', '')] },
                    ] as never),
                '不传 options 的旧调用仍必须拒绝新 storyCard',
            );
            assert.deepStrictEqual(await snapshotOf(userSubject), [], '拒写后 DB 为空不变得');
            const guestNoBase = { type: 'guest', id: `g_cutover09_${stamp}` } as Subject;
            await expectBadRequest(
                () => saveConversationForSubject(guestNoBase, [
                    { messageId: 'sneaky-g', role: 'assistant', content: 'NEW', parts: [storyCard('NEW', '')] },
                ] as never),
                'guest 无 baseline 调用仍必须拒绝新 storyCard',
            );
            assert.deepStrictEqual(await snapshotOf(guestNoBase), [], 'guest 拒写后 DB 为空不变得');
            await clearSubject(guestNoBase);
            // M4-08 fixup：tuple fingerprint 碰撞（no-baseline 路径，DB unchanged）。
            // persisted ("A", "B<NUL>C") vs incoming ("A<NUL>B", "C")——拼接 key 下同键，
            // tuple 下不同桶，后者是新 Legacy，必须 BAD_REQUEST。
            const NUL = String.fromCharCode(0);
            const guestColl = { type: 'guest', id: `g_cutover09c_${stamp}` } as Subject;
            await seedDirect(guestColl, [
                { messageId: 'A', role: 'assistant', content: `B${NUL}C`, parts: [storyCard(`B${NUL}C`, '')] },
            ]);
            const collBefore = await snapshotOf(guestColl);
            assert.strictEqual(collBefore.length, 1, '碰撞前置应为 1 条');
            await expectBadRequest(
                () => saveConversationForSubject(guestColl, [
                    { messageId: `A${NUL}B`, role: 'assistant', content: 'C', parts: [storyCard('C', '')] },
                ] as never),
                'NUL 碰撞的新 Legacy（无 baseline）必须拒绝',
            );
            assert.deepStrictEqual(await snapshotOf(guestColl), collBefore, '碰撞拒写后 DB 不变得');
            await clearSubject(guestColl);
        }
        console.log('PASS: M4-08-09 no-baseline blocked');

        console.log('=== M4-08-10: User / Guest symmetry + guest keep-limit intact ===');
        {
            // 对称矩阵：preservation PASS / origination REJECT，两边一致。
            const guestSym = { type: 'guest', id: `g_cutover10_${stamp}` } as Subject;
            await seedDirect(userSubject, [
                { messageId: 'sym-1', role: 'assistant', content: 'sym', parts: [storyCard('sym', '')] },
            ]);
            await seedDirect(guestSym, [
                { messageId: 'sym-1', role: 'assistant', content: 'sym', parts: [storyCard('sym', '')] },
            ]);
            for (const [tag, subject] of [['user', userSubject], ['guest', guestSym]] as Array<[string, Subject]>) {
                await saveFor(subject, [
                    { messageId: 'sym-1', role: 'assistant', content: 'sym', parts: [storyCard('sym', '')] },
                ]);
                await expectBadRequest(
                    () =>
                        saveFor(subject, [
                            { messageId: 'sym-1', role: 'assistant', content: 'sym', parts: [storyCard('sym', '')] },
                            { messageId: 'sym-new', role: 'assistant', content: 'NEW', parts: [storyCard('NEW', '')] },
                        ]),
                    `[${tag}] 对称：新增必须拒绝`,
                );
            }
            await clearSubject(userSubject);
            // guest keep-limit 既有行为不被破坏（纯文本 120 → 100）。
            const large: Array<Record<string, unknown>> = [];
            for (let i = 1; i <= 120; i++) {
                large.push({ messageId: `cap_${i}`, role: i % 2 === 1 ? 'user' : 'assistant', content: `cap ${i}` });
            }
            await saveFor(guestSym, large);
            const capped = await snapshotOf(guestSym);
            assert.strictEqual(capped.length, 100, 'guest 仍截断为 100 条');
            assert.strictEqual(capped[0].messageId, 'cap_21', '淘汰最旧，保留 newest 100');
            // cap 淘汰旧 Legacy 卡不触发 guard（删除允许）。
            await seedDirect(guestSym, [
                { messageId: 'cap-old', role: 'assistant', content: 'gone', parts: [storyCard('gone', '')] },
            ]);
            const fill: Array<Record<string, unknown>> = [];
            for (let i = 1; i <= 120; i++) {
                fill.push({ messageId: `fill_${i}`, role: 'user', content: `fill ${i}` });
            }
            await saveFor(guestSym, fill);
            const afterCap = await snapshotOf(guestSym);
            assert.ok(!afterCap.some((m) => m.messageId === 'cap-old'), 'cap 淘汰旧卡必须允许');
            await clearSubject(guestSym);
        }
        console.log('PASS: M4-08-10 symmetry + keep-limit');

        console.log('=== M4-08 baseline priority：stale + 非法 legacy 仍先 CONFLICT ===');
        {
            await seedDirect(userSubject, [
                { messageId: 'bp-1', role: 'assistant', content: 'base', parts: [storyCard('base', '')] },
            ]);
            const before = await snapshotOf(userSubject);
            // stale baseline + 非法新卡 → 必须先 CONFLICT（并发语义不变）。
            await assert.rejects(
                saveFor(
                    userSubject,
                    [
                        { messageId: 'bp-1', role: 'assistant', content: 'base', parts: [storyCard('base', '')] },
                        { messageId: 'bp-evil', role: 'assistant', content: 'EVIL', parts: [storyCard('EVIL', '')] },
                    ],
                    { expectedMessageIds: ['stale-id'] },
                ),
                (err: unknown) => err instanceof TRPCError && err.code === 'CONFLICT',
                'stale baseline 必须先报 CONFLICT',
            );
            assert.deepStrictEqual(await snapshotOf(userSubject), before, 'CONFLICT 后 DB 不变得');
            // 新鲜 baseline + 非法新卡 → BAD_REQUEST。
            const freshIds = before.map((m) => m.messageId);
            await expectBadRequest(
                () =>
                    saveFor(
                        userSubject,
                        [
                            { messageId: 'bp-1', role: 'assistant', content: 'base', parts: [storyCard('base', '')] },
                            { messageId: 'bp-evil', role: 'assistant', content: 'EVIL', parts: [storyCard('EVIL', '')] },
                        ],
                        { expectedMessageIds: freshIds },
                    ),
                '新鲜 baseline 下非法 legacy 必须报 BAD_REQUEST',
            );
            assert.deepStrictEqual(await snapshotOf(userSubject), before, 'BAD_REQUEST 后 DB 不变得');
            // 删除 Legacy（空快照）必须允许——read-compatible 不代表数据永存。
            await saveFor(userSubject, [], { expectedMessageIds: freshIds });
            assert.deepStrictEqual(await snapshotOf(userSubject), [], '清空删除必须可行');
            await clearSubject(userSubject);
        }
        console.log('PASS: M4-08 baseline priority + deletion allowed');
    } finally {
        await prisma.chatMessage.deleteMany({ where: { userId: user.id } });
        await prisma.user.deleteMany({ where: { id: user.id } });
    }

    console.log('ALL LEGACY CUTOVER INTEGRATION TESTS PASSED SUCCESSFULLY');
}

const testPromise = runLegacyCutoverTests()
    .then(() => {
        console.log('ALL LEGACY CUTOVER INTEGRATION TESTS PASSED SUCCESSFULLY');
    })
    .catch((err) => {
        console.error('Legacy cutover integration test failed:', err);
        process.exit(1);
    });

export default testPromise;
