import assert from 'node:assert';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { prisma } from '../../lib/db';
import { chatConversationRouter } from '../../lib/trpc/routers/chatConversation';
import { saveConversationInputSchema } from '../../lib/trpc/schemas/chatConversation';
import { TRPCError } from '../../lib/trpc/init';

/**
 * 构造待保存的单条会话消息。
 * @param messageId 合成消息 ID。
 * @param content 消息正文。
 */
function buildMessage(messageId: string, content: string) {
    return { messageId, role: 'user', content };
}

/**
 * 判断是否为 CONFLICT 错误（兼容 TRPCError 实例与 tRPC 客户端透传形态）。
 * @param error 待判断的错误。
 */
function isConflictError(error: unknown): boolean {
    if (error instanceof TRPCError && error.code === 'CONFLICT') {
        return true;
    }
    const code = (error as { code?: unknown } | null)?.code
        ?? (error as { data?: { code?: unknown } } | null)?.data?.code;
    if (code === 'CONFLICT') {
        return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('CONFLICT') || message.includes('其它标签页');
}

// 中文注释：H-15 全链路接线回归——schema/router/client 透传基线 + store 基线记忆与 CONFLICT 刷新。
// 覆盖：①双 save 真并发竞速（一成一 CONFLICT，Promise.all 双事务，经 router 基线透传）
// ②旧调用无基线仍可写兼容 ③客户端 CONFLICT 后刷新恢复（saveError+toast+重拉）。
// 全程隔离库，不碰 dev.db/app.db 与生产；store 段全内存打桩，不建 socket、不绑端口。
async function runH15WiringTests(): Promise<void> {
    // 中文注释：写库隔离守卫——绝不触碰 prisma/dev.db 与生产库。
    const dbUrl = process.env.DATABASE_URL ?? '';
    assert.ok(dbUrl, 'DATABASE_URL 必须由运行器注入隔离库');
    assert.ok(
        !dbUrl.includes('dev.db') && !dbUrl.includes('app.db'),
        `拒绝写真实/生产库，DATABASE_URL=${dbUrl.slice(0, 80)}`,
    );
    const stamp = Date.now();
    console.log('=== H-15-WIRING-00: schema 基线字段透传 ===');
    const parsed = saveConversationInputSchema.parse({
        messages: [buildMessage(`h15w_m0_${stamp}`, 'schema-base')],
        baseMessageIds: [`h15w_m0_${stamp}`],
    }) as { baseMessageIds?: string[] };
    assert.deepStrictEqual(
        parsed.baseMessageIds,
        [`h15w_m0_${stamp}`],
        'RED: schema 必须保留可选 baseMessageIds（透传给 router）',
    );
    const parsedLegacy = saveConversationInputSchema.parse({
        messages: [buildMessage(`h15w_m0_${stamp}`, 'schema-base')],
    }) as { baseMessageIds?: string[] };
    assert.ok(
        parsedLegacy.baseMessageIds === undefined,
        'schema 无基线时应保持可选缺省（向后兼容）',
    );
    console.log('PASS: H-15-WIRING-00 schema baseMessageIds');

    console.log('=== H-15-WIRING-01: 接线静态锁定（router/client/store）===');
    const routerSource = readFileSync(path.join(process.cwd(), 'lib', 'trpc', 'routers', 'chatConversation.ts'), 'utf8');
    assert.ok(routerSource.includes('baseMessageIds'), 'RED: router 必须透传 baseMessageIds');
    assert.ok(routerSource.includes('expectedMessageIds'), 'RED: router 必须映射为 expectedMessageIds');
    const clientSource = readFileSync(path.join(process.cwd(), 'lib', 'client', 'chatConversation.ts'), 'utf8');
    assert.ok(clientSource.includes('baseMessageIds'), 'RED: client saveMyConversation 必须接受 baseMessageIds');
    const storeSource = readFileSync(path.join(process.cwd(), 'stores', 'chatStore.ts'), 'utf8');
    assert.ok(storeSource.includes('CONFLICT'), 'RED: store 必须处理 CONFLICT');
    assert.ok(storeSource.includes('会话已被其它标签页更新，已刷新'), 'RED: store CONFLICT toast 文案不得漂移');
    assert.ok(storeSource.includes('GlassToast'), 'RED: store CONFLICT 必须经 GlassToast 提示');
    console.log('PASS: H-15-WIRING-01 wiring locked');

    console.log('=== H-15-WIRING-02: 双 save 真并发竞速（一成一 CONFLICT）===');
    const guestId = `g_h15wiring_${stamp}`;
    const guestCtx = { session: null, guestId, isGuest: true, clientIp: '127.0.0.1' };
    const tabACaller = chatConversationRouter.createCaller(guestCtx);
    const tabBCaller = chatConversationRouter.createCaller(guestCtx);
    try {
        await prisma.guestChatMessage.deleteMany({ where: { guestId } });
        const g1 = buildMessage(`h15w_g1_${stamp}`, 'wiring-base');
        await tabACaller.saveConversation({ messages: [g1] });
        const base = await tabACaller.getConversation();
        const baseIds = base.map((m) => m.messageId);
        assert.deepStrictEqual(baseIds, [g1.messageId], '基线快照应仅含 g1');

        const g2 = buildMessage(`h15w_g2_${stamp}`, 'tabA-increment');
        const g3 = buildMessage(`h15w_g3_${stamp}`, 'tabB-stale-increment');
        // 中文注释：真并发——同基线双事务同时发出，期望一成一 CONFLICT，不静默丢胜者增量。
        const raceA = tabACaller.saveConversation({ messages: [g1, g2], baseMessageIds: baseIds });
        const raceB = tabBCaller.saveConversation({ messages: [g1, g3], baseMessageIds: baseIds });
        const settled = await Promise.allSettled([raceA, raceB]);
        const fulfilled = settled.filter((r) => r.status === 'fulfilled');
        const rejected = settled.filter((r) => r.status === 'rejected');
        assert.strictEqual(fulfilled.length, 1, `真并发必须一成，实际成=${fulfilled.length}`);
        assert.strictEqual(rejected.length, 1, `真并发必须一败，实际败=${rejected.length}`);
        const loser = rejected[0] as PromiseRejectedResult;
        assert.ok(isConflictError(loser.reason), `败者必须为 CONFLICT，实际=${String(loser.reason)}`);
        const finalRows = await tabACaller.getConversation();
        const finalIds = finalRows.map((m) => m.messageId);
        assert.ok(
            (finalIds.length === 2 && finalIds[0] === g1.messageId && (finalIds[1] === g2.messageId || finalIds[1] === g3.messageId)),
            `终态必须为胜者快照 [g1,g2] 或 [g1,g3]，实际=${JSON.stringify(finalIds)}`,
        );
        console.log(`PASS: H-15-WIRING-02 race one-win one-CONFLICT final=${JSON.stringify(finalIds)}`);
    } finally {
        await prisma.guestChatMessage.deleteMany({ where: { guestId } });
    }

    console.log('=== H-15-WIRING-03: 旧调用无基线仍可写兼容 ===');
    const compatGuest = `g_h15compat_${stamp}`;
    const compatCtx = { session: null, guestId: compatGuest, isGuest: true, clientIp: '127.0.0.1' };
    const compatCaller = chatConversationRouter.createCaller(compatCtx);
    try {
        await prisma.guestChatMessage.deleteMany({ where: { guestId: compatGuest } });
        const c1 = buildMessage(`h15w_c1_${stamp}`, 'compat-base');
        await compatCaller.saveConversation({ messages: [c1] });
        const c2 = buildMessage(`h15w_c2_${stamp}`, 'compat-legacy-write');
        await compatCaller.saveConversation({ messages: [c1, c2] });
        const afterLegacy = await compatCaller.getConversation();
        assert.ok(
            afterLegacy.some((m) => m.messageId === c2.messageId),
            '无 baseMessageIds 的旧调用应保持可写（向后兼容）',
        );
        console.log('PASS: H-15-WIRING-03 legacy write compatible');
    } finally {
        await prisma.guestChatMessage.deleteMany({ where: { guestId: compatGuest } });
    }

    console.log('=== H-15-WIRING-04: 客户端 CONFLICT 后刷新恢复 ===');
    const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
    // 中文注释：GlassToast 可控桩——经 globalThis 注入（store 懒加载，避免 Node 启动解析 .tsx）。
    const toastCalls: Array<{ icon?: string; content: string }> = [];
    (globalThis as { __H15_TOAST__?: { show: (c: { icon?: string; content: string }) => void } }).__H15_TOAST__ = {
        show: (c: { icon?: string; content: string }) => { toastCalls.push(c); },
    };
    const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
    nodeRequire.cache[glassToastPath] = {
        id: glassToastPath,
        filename: glassToastPath,
        loaded: true,
        exports: { default: { show: (c: { icon?: string; content: string }) => { toastCalls.push(c); }, clear: () => {} } },
    } as unknown as NodeModule;
    // 中文注释：会话落库可控桩——记录基线透传；CONFLICT 态抛 TRPCError 供刷新断言。
    type DtoLike = { messageId: string; role: string; content: string };
    let stubFetchRows: DtoLike[] = [{ messageId: `h15w_s1_${stamp}`, role: 'user', content: 'server-base' }];
    let fetchCount = 0;
    const saveCalls: Array<{ messages: DtoLike[]; baseMessageIds?: string[] }> = [];
    let saveMode: 'success' | 'conflict' = 'success';
    const chatConversationPath = path.resolve(process.cwd(), 'lib/client/chatConversation.ts');
    nodeRequire.cache[chatConversationPath] = {
        id: chatConversationPath,
        filename: chatConversationPath,
        loaded: true,
        exports: {
            fetchMyConversation: async () => {
                fetchCount += 1;
                return stubFetchRows.map((r) => ({ ...r }));
            },
            saveMyConversation: async (messages: DtoLike[], baseMessageIds?: string[]) => {
                saveCalls.push({ messages, baseMessageIds });
                if (saveMode === 'conflict') {
                    throw new TRPCError({ code: 'CONFLICT', message: '会话已被其它标签页更新，本次写入已拒绝，请刷新后重试' });
                }
                return { success: true };
            },
        },
    } as unknown as NodeModule;
    const chatStoreModule = nodeRequire('../../stores/chatStore') as Record<string, unknown>;
    const { useChatStore } = chatStoreModule as {
        useChatStore: typeof import('../../stores/chatStore').useChatStore;
    };
    // 中文注释：读基线——initForUser 拉取成功后记 messageId 序列，保存时透传。
    useChatStore.getState().reset();
    toastCalls.length = 0;
    saveCalls.length = 0;
    fetchCount = 0;
    await useChatStore.getState().initForUser();
    assert.strictEqual(fetchCount, 1, 'initForUser 应拉取一次服务端快照');
    assert.ok(
        useChatStore.getState().messages.some((m) => m.id === `h15w_s1_${stamp}`),
        'initForUser 应恢复服务端基线消息',
    );
    // 中文注释：本地新增已完结消息并落盘，断言保存时带上读取基线。
    const now = new Date().toISOString();
    useChatStore.setState({
        messages: [
            ...useChatStore.getState().messages,
            { id: `h15w_local_${stamp}`, role: 'user', content: '本地增量', status: 'delivered', createdAt: now },
        ],
    });
    saveCalls.length = 0;
    const firstFlush = await useChatStore.getState().flushPendingSave();
    assert.strictEqual(firstFlush, true, '基线新鲜时 flush 应成功');
    assert.strictEqual(saveCalls.length, 1, 'flush 应产生一次保存');
    assert.deepStrictEqual(
        saveCalls[0].baseMessageIds,
        [`h15w_s1_${stamp}`],
        'RED: 保存时必须带上读取基线 expectedMessageIds',
    );
    // 中文注释：模拟它 tab 已更新——服务端新增 s2，本地基于旧基线再写必 CONFLICT。
    stubFetchRows = [
        { messageId: `h15w_s1_${stamp}`, role: 'user', content: 'server-base' },
        { messageId: `h15w_s2_${stamp}`, role: 'assistant', content: 'other-tab-increment' },
    ];
    // 本地再追加一条，制造 stale 写。
    useChatStore.setState({
        messages: [
            ...useChatStore.getState().messages,
            { id: `h15w_stale_${stamp}`, role: 'user', content: '陈旧增量', status: 'delivered', createdAt: now },
        ],
    });
    // 中文注释：注意基线仍为旧 s1（上次成功保存的快照不含 s2），下次保存若带基线则服务端应拒写；
    // 此处桩直接以 CONFLICT 模拟服务端拒写，断言客户端不静默丢。
    saveMode = 'conflict';
    toastCalls.length = 0;
    const fetchBeforeConflict = fetchCount;
    const conflictFlush = await useChatStore.getState().flushPendingSave();
    assert.strictEqual(conflictFlush, false, 'CONFLICT 时 flush 应返回 false');
    const saveError = useChatStore.getState().saveError as unknown;
    assert.ok(typeof saveError === 'string' && saveError.length > 0, 'CONFLICT 必须置 saveError，不静默丢');
    assert.ok(
        toastCalls.some((c) => c.content === '会话已被其它标签页更新，已刷新'),
        'CONFLICT 必须 toast“会话已被其它标签页更新，已刷新”',
    );
    assert.ok(fetchCount > fetchBeforeConflict, 'CONFLICT 后必须经 initForUser 口径刷新（重拉服务端）');
    assert.ok(
        useChatStore.getState().messages.some((m) => m.id === `h15w_s2_${stamp}`),
        '刷新后应呈现它 tab 增量 s2',
    );
    // 中文注释：刷新恢复——新基线下再次保存应成功且清除标记位。
    saveMode = 'success';
    saveCalls.length = 0;
    const retryFlush = await useChatStore.getState().flushPendingSave();
    assert.strictEqual(retryFlush, true, '刷新后新基线保存应成功');
    assert.strictEqual(useChatStore.getState().saveError, null, '成功后标记位应清除');
    assert.deepStrictEqual(
        saveCalls[0].baseMessageIds,
        [`h15w_s1_${stamp}`, `h15w_s2_${stamp}`],
        '刷新后基线应更新为服务端新鲜序列',
    );
    useChatStore.getState().reset();
    delete (globalThis as { __H15_TOAST__?: unknown }).__H15_TOAST__;
    console.log('PASS: H-15-WIRING-04 conflict refresh recovered');

    console.log('\nALL H-15 WIRING E2E TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runH15WiringTests()
    .then(() => {
        console.log('ALL H-15 WIRING E2E TEST CASES PASSED SUCCESSFULLY!');
    })
    .catch((err) => {
        console.error('H-15 wiring test failed:', err);
        process.exit(1);
    });

export default testPromise;
