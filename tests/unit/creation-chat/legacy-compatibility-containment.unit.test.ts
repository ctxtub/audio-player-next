import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { LibraryCreateInput, StoryWorkDetailDTO } from '../../../lib/trpc/schemas/library';
import {
  isChatArtifact,
  isCompleteArtifact,
  isDraftArtifact,
} from '../../../types/chatArtifact';
import type {
  ChatMessage,
  MessagePart,
  StoryCardPart,
} from '../../../types/chat';
import {
  extractTextFromParts,
  isStoryArtifactPart,
  isStoryCardPart,
} from '../../../types/chat';
import {
  decodeLegacyStoryCard,
  findLegacyPlayableStoryCard,
  hasAnyStoryPart,
  hasLegacyStoryCard,
  hasStoryContent,
} from '../../../lib/client/chatStoryCompatibility';
import {
  assertNoNewLegacyStoryCardWrites,
} from '../../../lib/server/chatConversation';
import { TRPCError } from '../../../lib/trpc/init';
import {
  rehydrateServerMessages,
  serializePartsForHistory,
} from '../../../lib/client/chatArtifactHistory';
import {
  canonicalizeArtifactForHistory,
} from '../../../lib/client/chatArtifactHistory';
import {
  completeArtifact,
  createDraftArtifact,
  interruptArtifact,
  markPromotionFailed,
  markPromotionSuccess,
  startPromotion,
} from '../../../lib/client/chatArtifactState';

// 中文注释：M4-09 Legacy Compatibility Containment / Artifact Boundary Cleanup 回归（E2E-08-09）。
// structural cleanup, semantic no-op：现代 chatStore / Artifact 状态机不再直读 Legacy wire，
// 全部经 lib/client/chatStoryCompatibility.ts 唯一边界；M4-06 History 与 M4-08 provenance 零变化。
// 本文件覆盖 M4-09-01~11（M4-09-12 为全量复跑，由 runner 口径执行）。
// 全程内存打桩，不建 socket、不绑端口，不碰 prisma/dev.db。

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

// 中文注释：先占桩——GlassToast / 会话落库 / Agent 交互，必须在 require chatStore 之前占位。
const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
nodeRequire.cache[glassToastPath] = {
  id: glassToastPath,
  filename: glassToastPath,
  loaded: true,
  exports: { default: { show: () => {}, clear: () => {} } },
} as unknown as NodeModule;

const chatConversationPath = path.resolve(process.cwd(), 'lib/client/chatConversation.ts');
nodeRequire.cache[chatConversationPath] = {
  id: chatConversationPath,
  filename: chatConversationPath,
  loaded: true,
  exports: {
    fetchMyConversation: async () => [],
    saveMyConversation: async () => ({ ok: true }),
  },
} as unknown as NodeModule;

const agentFlowPath = path.resolve(process.cwd(), 'app/services/agentFlow.ts');
nodeRequire.cache[agentFlowPath] = {
  id: agentFlowPath,
  filename: agentFlowPath,
  loaded: true,
  exports: {
    interactWithAgent: async () => {},
    summarizeContext: async () => '探针摘要-M409',
  },
} as unknown as NodeModule;

const { useChatStore } = nodeRequire('../../../stores/chatStore') as {
  useChatStore: typeof import('../../../stores/chatStore').useChatStore;
};

const { setPromotionCreateOverride } = nodeRequire(
  '../../../lib/client/chatPromotionOrchestration',
) as {
  setPromotionCreateOverride: typeof import('../../../lib/client/chatPromotionOrchestration').setPromotionCreateOverride;
};
let createCalls: LibraryCreateInput[] = [];
let pendingCreates: {
  input: LibraryCreateInput;
  resolve: (dto: StoryWorkDetailDTO) => void;
  reject: (err: unknown) => void;
}[] = [];
setPromotionCreateOverride((input: LibraryCreateInput) => {
  createCalls.push(input);
  return new Promise<StoryWorkDetailDTO>((resolve, reject) => {
    pendingCreates.push({ input, resolve, reject });
  });
});

type DispatchArg = Parameters<ReturnType<typeof useChatStore.getState>['dispatch']>[0];

function resetBaseline(): void {
  useChatStore.getState().reset();
  useChatStore.setState({ syncEnabled: false });
  createCalls = [];
  pendingCreates = [];
}

function makeDto(id: number, input: LibraryCreateInput): StoryWorkDetailDTO {
  return {
    id,
    title: input.title ?? '测试标题',
    excerpt: input.storyText.slice(0, 20),
    voiceId: input.voiceId ?? '',
    contentHash: `hash-${id}`,
    favoritedAt: null,
    deletedAt: null,
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z',
    audio: { status: 'missing', durationMs: null },
    prompt: input.prompt,
    storyText: input.storyText,
    sourceMessageId: input.sourceMessageId ?? null,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await Promise.resolve();
  await Promise.resolve();
}

function makeReadyArtifact(sourceMessageId: string, storyText = '现代正文-ready') {
  const draft = createDraftArtifact({ sourceMessageId, initialText: storyText });
  const completed = completeArtifact(draft, { finalStoryText: storyText });
  const promoting = startPromotion(completed);
  return markPromotionSuccess(promoting, { storyWorkId: 777 });
}

function msg(
  id: string,
  role: ChatMessage['role'],
  parts?: MessagePart[],
  extra?: Partial<ChatMessage>,
): ChatMessage {
  return {
    id,
    role,
    content: 'c-' + id,
    parts,
    status: 'delivered',
    createdAt: '2026-09-12T10:00:00.000Z',
    ...extra,
  } as ChatMessage;
}

const legacyCard = (storyText: string, audioUrl = 'https://audio/old.mp3'): MessagePart =>
  ({ type: 'storyCard', storyText, audioUrl }) as MessagePart;

async function main(): Promise<void> {
  console.log('=== M4-09-01: Legacy decoder relocation parity ===');
  {
    // 合法：与 M4-08 前逐字一致。
    const ok = decodeLegacyStoryCard({ type: 'storyCard', storyText: 'legacy', audioUrl: 'old-url' });
    assert.ok(ok !== null, '合法卡必须解码');
    assert.strictEqual(ok.type, 'storyCard');
    assert.strictEqual(ok.storyText, 'legacy');
    assert.strictEqual(ok.audioUrl, 'old-url');
    // 非法：全部 null。
    assert.strictEqual(decodeLegacyStoryCard(null), null, 'null→null');
    assert.strictEqual(decodeLegacyStoryCard({}), null, '空对象→null');
    assert.strictEqual(decodeLegacyStoryCard({ type: 'text', content: 'hi' }), null, '错 type→null');
    assert.strictEqual(decodeLegacyStoryCard({ type: 'storyCard', storyText: '  ', audioUrl: 'u' }), null, '空正文→null');
    assert.strictEqual(decodeLegacyStoryCard({ type: 'storyCard', storyText: 's' }), null, '缺 audioUrl→null');
    assert.strictEqual(decodeLegacyStoryCard({ type: 'storyCard', storyText: 's', audioUrl: 123 }), null, '非 string audioUrl→null');
    // 只读铁律：绝非 Artifact，不可 promotion。
    assert.strictEqual(isChatArtifact(ok as never), false, 'Legacy 卡绝非 ChatArtifact');
    assert.strictEqual(isDraftArtifact(ok as never), false);
    assert.strictEqual(isCompleteArtifact(ok as never), false);
    // decoder 为纯读：静态确认不触达 create / library / promotion。
    const compatSource = fs.readFileSync(
      path.resolve(process.cwd(), 'lib/client/chatStoryCompatibility.ts'), 'utf8',
    );
    assert.ok(!/library\s*\.\s*create\s*\(/.test(compatSource), 'decoder 不得调用 library.create');
    assert.ok(!/from\s+['"][^'"]*library[^'"]*['"]/i.test(compatSource), 'decoder 不得 import Library');
    assert.ok(!/createDraftArtifact|startPromotion|promoteStoryArtifact/.test(compatSource), 'decoder 不得触达 Artifact create/promotion');
    assert.strictEqual(createCalls.length, 0, 'decoder 不得 kick promotion');
    console.log('PASS: M4-09-01 decoder parity');
  }

  console.log('=== M4-09-02: Modern Artifact state module purity ===');
  {
    const stateSource = fs.readFileSync(
      path.resolve(process.cwd(), 'lib/client/chatArtifactState.ts'), 'utf8',
    );
    assert.ok(!/['"]storyCard['"]/.test(stateSource), 'chatArtifactState 不得出现 wire 字面量');
    assert.ok(!stateSource.includes('StoryCardPart'), 'chatArtifactState 不得出现 Legacy 类型');
    assert.ok(!stateSource.includes('decodeLegacyStoryCard'), 'decoder 已迁出，不得残留');
    // lifecycle spot： relocation 不改状态机。
    const draft = createDraftArtifact({ sourceMessageId: 'm409-02', initialText: 'a' });
    const completed = completeArtifact(draft, { finalStoryText: 'ab' });
    assert.strictEqual(completed.status, 'complete');
    const promoting = startPromotion(completed);
    const ready = markPromotionSuccess(promoting, { storyWorkId: 1 });
    assert.strictEqual(ready.status, 'ready');
    assert.strictEqual(ready.storyWorkId, 1);
    const failed = markPromotionFailed(startPromotion(completeArtifact(createDraftArtifact({ sourceMessageId: 'm409-02b', initialText: 'x' }), { finalStoryText: 'xy' })));
    assert.strictEqual(failed.status, 'promotion_failed');
    const interrupted = interruptArtifact(createDraftArtifact({ sourceMessageId: 'm409-02c', initialText: 'z' }));
    assert.strictEqual(interrupted.status, 'interrupted');
    assert.throws(() => startPromotion(draft as never), /非法状态转移/);
    console.log('PASS: M4-09-02 state purity');
  }

  console.log('=== M4-09-03: Chat store no Legacy wire knowledge ===');
  {
    const storeSource = fs.readFileSync(path.resolve(process.cwd(), 'stores/chatStore.ts'), 'utf8');
    assert.ok(!/['"]storyCard['"]/.test(storeSource), 'chatStore 不得出现 wire 字面量');
    assert.ok(!storeSource.includes('StoryCardPart'), 'chatStore 不得 import Legacy 类型');
    assert.ok(storeSource.includes('chatStoryCompatibility'), 'chatStore 必须经 helper 查询');
    assert.ok(storeSource.includes('hasLegacyStoryCard'), 'intent 保护必须经 helper');
    assert.ok(storeSource.includes('hasAnyStoryPart'), 'isLatestMessage 必须经 helper');
    assert.ok(storeSource.includes('hasStoryContent'), 'hasStoryMessages 必须经 helper');
    assert.ok(storeSource.includes('findLegacyPlayableStoryCard'), 'nextStorySegment 必须经 helper');
    // transport-level fallback 保持：无 messageId 仍回退最后 sending。
    resetBaseline();
    useChatStore.getState().dispatch({ type: 'user.submit', content: '讲个故事' } as DispatchArg);
    const asstId = useChatStore.getState().selectors.latestAssistantMessage()?.id;
    assert.ok(asstId, 'assistant 占位必须存在');
    useChatStore.getState().dispatch({ type: 'stream.delta', content: '从前' } as unknown as DispatchArg);
    const after = useChatStore.getState().messages.find((m) => m.id === asstId);
    assert.ok(after, 'fallback 必须命中最后 sending');
    const artifactText = (after.parts?.find((p) => p.type === 'storyArtifact') as { artifact: { storyText: string } } | undefined)?.artifact.storyText;
    assert.strictEqual(artifactText, '从前', '无 id delta 仍追加（fallback 保持）');
    console.log('PASS: M4-09-03 store purity + transport fallback');
  }

  console.log('=== M4-09-04: Legacy Story intent preservation ===');
  {
    resetBaseline();
    const legacy: ChatMessage = msg('hist-legacy-1', 'assistant', [legacyCard('守夜人的灯', 'blob:old')]);
    useChatStore.setState({ messages: [msg('u-1', 'user', undefined, { content: 'hi' }), legacy] });
    useChatStore.getState().dispatch({ type: 'stream.intent', intent: 'Story', messageId: 'hist-legacy-1' } as DispatchArg);
    const kept = useChatStore.getState().messages.find((m) => m.id === 'hist-legacy-1');
    assert.ok(kept, '历史消息必须保留');
    assert.strictEqual(kept.parts?.[0]?.type, 'storyCard', '原 storyCard 精确保留');
    assert.strictEqual((kept.parts?.[0] as StoryCardPart).storyText, '守夜人的灯');
    assert.ok(!(kept.parts ?? []).some((p) => p.type === 'storyArtifact'), '不得创建 storyArtifact');
    assert.strictEqual(pendingCreates.length, 0, '不得 promotion');
    assert.strictEqual(createCalls.length, 0, '不得 library.create');
    assert.strictEqual(kept.metadata?.agentType, 'story_agent', 'agentType 按原行为更新');
    console.log('PASS: M4-09-04 intent preservation');
  }

  console.log('=== M4-09-05: isLatestMessage parity ===');
  {
    resetBaseline();
    // 混合序列：text → legacy → 现代空正文 → 现代非空（最后故事为现代非空）。
    const modernEmpty = msg('m-empty', 'assistant', [
      { type: 'storyArtifact', artifact: createDraftArtifact({ sourceMessageId: 'm-empty', initialText: '' }) },
    ] as unknown as MessagePart[]);
    const modernFull = msg('m-full', 'assistant', [
      { type: 'storyArtifact', artifact: makeReadyArtifact('m-full', '完整正文') },
    ] as unknown as MessagePart[]);
    useChatStore.setState({
      messages: [
        msg('t-1', 'assistant', [{ type: 'text', content: 'hi' }]),
        msg('l-1', 'assistant', [legacyCard('旧故事', 'u1')]),
        modernEmpty,
        modernFull,
      ],
    });
    const sel = useChatStore.getState().selectors;
    assert.strictEqual(sel.isLatestMessage('m-full'), true, '最后故事消息为 latest');
    assert.strictEqual(sel.isLatestMessage('l-1'), false, '非最后故事不为 latest');
    assert.strictEqual(sel.isLatestMessage('t-1'), false, 'text 永不为 latest');
    // 关键区分：空正文现代 Artifact 仍按“存在 story part”语义处理。
    assert.strictEqual(hasAnyStoryPart(modernEmpty.parts), true, '空正文仍是 story part');
    assert.strictEqual(hasStoryContent(modernEmpty.parts), false, '空正文不是 story content');
    useChatStore.setState({ messages: [msg('t-1', 'assistant', [{ type: 'text', content: 'hi' }]), modernEmpty] });
    assert.strictEqual(
      useChatStore.getState().selectors.isLatestMessage('m-empty'), true,
      '空正文现代 Artifact 仍可为 latest（不得被 hasStoryContent 混掉）',
    );
    // helper 与旧内联语义逐项一致。
    assert.strictEqual(hasAnyStoryPart([legacyCard('a', 'u')] as MessagePart[]), true);
    assert.strictEqual(hasAnyStoryPart(undefined), false);
    assert.strictEqual(hasAnyStoryPart([{ type: 'text', content: 'x' }]), false);
    console.log('PASS: M4-09-05 isLatestMessage');
  }

  console.log('=== M4-09-06: hasStoryMessages parity ===');
  {
    resetBaseline();
    const modernFull = msg('mf', 'assistant', [
      { type: 'storyArtifact', artifact: makeReadyArtifact('mf', '有正文') },
    ] as unknown as MessagePart[]);
    const modernWs = msg('mw', 'assistant', [
      { type: 'storyArtifact', artifact: { ...(makeReadyArtifact('mw', '占位') as unknown as Record<string, unknown>), storyText: '   ' } as never },
    ] as unknown as MessagePart[]);
    // 注意：空白正文 ready 违反 domain invariant，仅用于 selector 输入 parity；
    // 不经状态机构造，直接以 parts 形态断言旧分支语义（trim === '' → false）。
    useChatStore.setState({
      messages: [
        msg('t', 'assistant', [{ type: 'text', content: 'hi' }]),
        msg('leg', 'assistant', [legacyCard('旧', 'u')]),
        modernFull,
        modernWs,
      ],
    });
    const sel = useChatStore.getState().selectors;
    assert.strictEqual(sel.hasStoryMessages(), true, 'legacy + 现代非空 → true');
    useChatStore.setState({ messages: [msg('t', 'assistant', [{ type: 'text', content: 'hi' }])] });
    assert.strictEqual(useChatStore.getState().selectors.hasStoryMessages(), false, 'text-only → false');
    useChatStore.setState({ messages: [modernWs] });
    assert.strictEqual(useChatStore.getState().selectors.hasStoryMessages(), false, '空白正文现代 → false');
    useChatStore.setState({ messages: [msg('leg', 'assistant', [legacyCard('旧', 'u')])] });
    assert.strictEqual(useChatStore.getState().selectors.hasStoryMessages(), true, 'legacy → true');
    // exclude 语义保持：只搜 targetIndex 之前。
    useChatStore.setState({
      messages: [
        msg('leg', 'assistant', [legacyCard('旧', 'u')]),
        msg('tail', 'assistant', [{ type: 'text', content: 'hi' }]),
      ],
    });
    assert.strictEqual(useChatStore.getState().selectors.hasStoryMessages('tail'), true, 'exclude tail 前有故事 → true');
    assert.strictEqual(useChatStore.getState().selectors.hasStoryMessages('leg'), false, 'exclude 首个故事之前无故事 → false');
    assert.strictEqual(useChatStore.getState().selectors.hasStoryMessages('missing-id'), true, '未知 id 搜全量');
    // helper 直测。
    assert.strictEqual(hasStoryContent([legacyCard('a', 'u')] as MessagePart[]), true);
    assert.strictEqual(hasStoryContent([{ type: 'text', content: 'x' }]), false);
    assert.strictEqual(hasStoryContent(undefined), false);
    assert.strictEqual(hasLegacyStoryCard([legacyCard('a', 'u')] as MessagePart[]), true);
    assert.strictEqual(hasLegacyStoryCard([{ type: 'text', content: 'x' }]), false);
    console.log('PASS: M4-09-06 hasStoryMessages');
  }

  console.log('=== M4-09-07: Legacy nextStorySegment parity ===');
  {
    resetBaseline();
    const modernReady = msg('m-mod', 'assistant', [
      { type: 'storyArtifact', artifact: makeReadyArtifact('m-mod', '现代就绪正文') },
    ] as unknown as MessagePart[]);
    useChatStore.setState({
      messages: [
        msg('start', 'assistant', [{ type: 'text', content: 'go' }]),
        msg('leg-a', 'assistant', [legacyCard('第一段', 'audio-a')]),
        modernReady,
        msg('leg-noaudio', 'assistant', [legacyCard('无音频段', '')]),
        msg('leg-b', 'assistant', [legacyCard('第二段', 'audio-b')]),
      ],
    });
    const sel = useChatStore.getState().selectors;
    const first = sel.nextStorySegment('start');
    assert.deepStrictEqual(first, { audioUrl: 'audio-a', storyText: '第一段', messageId: 'leg-a' }, '只返回下一个 Legacy playable');
    const second = sel.nextStorySegment('leg-a');
    assert.deepStrictEqual(second, { audioUrl: 'audio-b', storyText: '第二段', messageId: 'leg-b' }, '跳过现代 Artifact 与空音频 Legacy');
    assert.strictEqual(sel.nextStorySegment('leg-b'), null, '末尾返回 null');
    assert.strictEqual(sel.nextStorySegment('missing'), null, '未知 id 返回 null');
    assert.strictEqual(pendingCreates.length, 0, '不得产生 promotion');
    assert.strictEqual(createCalls.length, 0, '不得 audio manifest / library 查询');
    // helper 直测：现代不参加，空音频跳过。
    assert.strictEqual(findLegacyPlayableStoryCard(undefined), undefined);
    assert.strictEqual(
      findLegacyPlayableStoryCard([{ type: 'storyArtifact', artifact: makeReadyArtifact('x', 't') }] as unknown as MessagePart[]),
      undefined,
      '现代 Artifact 永不参加',
    );
    assert.strictEqual(
      findLegacyPlayableStoryCard([legacyCard('t', '')] as MessagePart[]),
      undefined,
      '空音频跳过',
    );
    console.log('PASS: M4-09-07 nextStorySegment');
  }

  console.log('=== M4-09-08: MessagePart read compatibility ===');
  {
    const card: MessagePart = { type: 'storyCard', storyText: '旧正文', audioUrl: 'u' } as MessagePart;
    assert.strictEqual(isStoryCardPart(card), true, 'isStoryCardPart 保留');
    assert.strictEqual(extractTextFromParts([card]), '旧正文', 'extract 取 storyText');
    const ready = makeReadyArtifact('m409-08', '现代正文');
    const apart: MessagePart = { type: 'storyArtifact', artifact: ready } as unknown as MessagePart;
    assert.strictEqual(isStoryArtifactPart(apart), true);
    assert.strictEqual(extractTextFromParts([apart]), '现代正文', 'extract 取 artifact.storyText');
    console.log('PASS: M4-09-08 read compat');
  }

  console.log('=== M4-09-09: M4-06 History contract unchanged ===');
  {
    // save：storyCard clone + audioUrl=''.
    const serialized = serializePartsForHistory([legacyCard('legacy-正文', 'https://audio/legacy.mp3')] as MessagePart[]);
    assert.ok(serialized, '序列化不得为空');
    assert.strictEqual(serialized?.[0]?.type, 'storyCard', '不转 Artifact');
    assert.strictEqual((serialized?.[0] as StoryCardPart).storyText, 'legacy-正文');
    assert.strictEqual((serialized?.[0] as StoryCardPart).audioUrl, '', 'audioUrl 清空保持');
    // load：storyCard 原样透传，不转 Artifact。
    const rehydrated = rehydrateServerMessages([{
      messageId: 'old-1', role: 'assistant', content: 'legacy-正文',
      parts: [{ type: 'storyCard', storyText: 'legacy-正文', audioUrl: '' }],
    }] as never);
    assert.strictEqual(rehydrated[0].parts?.[0]?.type, 'storyCard', 'load 不转 Artifact');
    assert.strictEqual((rehydrated[0].parts?.[0] as StoryCardPart).storyText, 'legacy-正文');
    // transient 降级冻结。
    const draft = createDraftArtifact({ sourceMessageId: 'h-1', initialText: 'd' });
    assert.strictEqual(canonicalizeArtifactForHistory(draft).status, 'interrupted', 'draft→interrupted');
    const completed = completeArtifact(createDraftArtifact({ sourceMessageId: 'h-2', initialText: 'x' }), { finalStoryText: 'xy' });
    assert.strictEqual(canonicalizeArtifactForHistory(completed).status, 'promotion_failed', 'complete→promotion_failed');
    const promoting = startPromotion(completeArtifact(createDraftArtifact({ sourceMessageId: 'h-3', initialText: 'x' }), { finalStoryText: 'xy' }));
    assert.strictEqual(canonicalizeArtifactForHistory(promoting).status, 'promotion_failed', 'promoting→promotion_failed');
    console.log('PASS: M4-09-09 history contract');
  }

  console.log('=== M4-09-10: M4-08 provenance firewall unchanged ===');
  {
    const persisted = [{ messageId: 'old-1', parts: JSON.stringify([{ type: 'storyCard', storyText: 'legacy', audioUrl: '' }]) }];
    const same = [{ messageId: 'old-1', role: 'assistant', content: 'legacy', parts: [{ type: 'storyCard', storyText: 'legacy', audioUrl: '' }] }];
    assert.doesNotThrow(() => assertNoNewLegacyStoryCardWrites(persisted, same as never), '原样续存 PASS');
    // audioUrl 差异视为同一张卡。
    const audioDiff = [{ messageId: 'old-1', role: 'assistant', content: 'legacy', parts: [{ type: 'storyCard', storyText: 'legacy', audioUrl: 'https://temporary/x' }] }];
    assert.doesNotThrow(() => assertNoNewLegacyStoryCardWrites(persisted, audioDiff as never), 'audioUrl 差异 PASS');
    // 新卡 / 篡改 / 复制 / 无基线一律 BAD_REQUEST。
    assert.throws(
      () => assertNoNewLegacyStoryCardWrites([], [{ messageId: 'new-legacy', role: 'assistant', content: 'N', parts: [{ type: 'storyCard', storyText: 'N', audioUrl: '' }] }] as never),
      (e: unknown) => e instanceof TRPCError && e.code === 'BAD_REQUEST',
      '无中生有 REJECT',
    );
    assert.throws(
      () => assertNoNewLegacyStoryCardWrites(persisted, [{ messageId: 'old-1', role: 'assistant', content: 'NEW', parts: [{ type: 'storyCard', storyText: 'NEW', audioUrl: '' }] }] as never),
      (e: unknown) => e instanceof TRPCError && e.code === 'BAD_REQUEST',
      '篡改 REJECT',
    );
    assert.throws(
      () => assertNoNewLegacyStoryCardWrites(persisted, [{ messageId: 'old-1', role: 'assistant', content: 'legacy', parts: [{ type: 'storyCard', storyText: 'legacy', audioUrl: '' }, { type: 'storyCard', storyText: 'legacy', audioUrl: '' }] }] as never),
      (e: unknown) => e instanceof TRPCError && e.code === 'BAD_REQUEST',
      '复制扩增 REJECT',
    );
    // 删除 PASS。
    assert.doesNotThrow(
      () => assertNoNewLegacyStoryCardWrites(persisted, [{ messageId: 'old-1', role: 'assistant', content: 'legacy', parts: [] }] as never),
      '删除 PASS',
    );
    // tuple 碰撞：拼接同键但 tuple 不同桶，后者是新卡必须 REJECT；相同 tuple 通过。
    const nulPersisted = [{ messageId: 'A', parts: JSON.stringify([{ type: 'storyCard', storyText: 'B\u0000C', audioUrl: '' }]) }];
    assert.throws(
      () => assertNoNewLegacyStoryCardWrites(nulPersisted, [{ messageId: 'A\u0000B', role: 'assistant', content: 'C', parts: [{ type: 'storyCard', storyText: 'C', audioUrl: '' }] }] as never),
      (e: unknown) => e instanceof TRPCError && e.code === 'BAD_REQUEST',
      'collision REJECT',
    );
    assert.doesNotThrow(
      () => assertNoNewLegacyStoryCardWrites(nulPersisted, [{ messageId: 'A', role: 'assistant', content: 'B\u0000C', parts: [{ type: 'storyCard', storyText: 'B\u0000C', audioUrl: '' }] }] as never),
      '相同 tuple PASS',
    );
    // guard 为纯函数：user / guest 共用同一 helper（对称由 L2 覆盖，此处断言同一函数无身份分支）。
    const guardSource = fs.readFileSync(path.resolve(process.cwd(), 'lib/server/chatConversation.ts'), 'utf8');
    assert.ok(guardSource.includes('assertNoNewLegacyStoryCardWrites'), 'guard helper 必须存在');
    console.log('PASS: M4-09-10 provenance firewall');
  }

  console.log('=== M4-09-11: Legacy dependency allowlist (blocking) ===');
  {
    const WIRE_RE = /['"]storyCard['"]/;
    const TYPE_RE = /StoryCardPart/;
    const DECODE_RE = /decodeLegacyStoryCard/;
    const approved = new Set([
      'types/chat.ts',
      'lib/client/chatStoryCompatibility.ts',
      'lib/client/chatArtifactHistory.ts',
      'lib/server/chatConversation.ts',
      'app/(main)/chat/components/MessageParts/index.tsx',
      'app/(main)/chat/components/MessageParts/StoryCardPart.tsx',
      // 旧 playback compatibility 纯 reader（M4-09 审计逐个批准）：
      // storyFlow：startStoryPlayback 读历史卡 storyText 注册断点活跃故事；
      // playbackProgressStore：resume 读历史卡 storyText；
      // M5-09 fixup：playbackSessionStore 不再直读 wire（经 canonical resolver 间接消费），
      // Draft 快照唯一入口收敛在 playbackDraftSnapshot（Modern first → Legacy fallback）；
      // MessageBubble：卡片视图/实质内容判定需识别历史卡形态，无构造无转换。
      'app/services/storyFlow.ts',
      'stores/playbackProgressStore.ts',
      'lib/client/playbackDraftSnapshot.ts',
      'app/(main)/chat/components/ChatLog/MessageBubble/index.tsx',
    ]);
    const scanRoots = ['app', 'lib', 'stores', 'components', 'types'];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const rel = path.relative(process.cwd(), full);
        const content = fs.readFileSync(full, 'utf8');
        if (WIRE_RE.test(content) || TYPE_RE.test(content) || DECODE_RE.test(content)) {
          if (!approved.has(rel)) {
            offenders.push(rel);
          }
        }
      }
    };
    for (const root of scanRoots) {
      walk(path.resolve(process.cwd(), root));
    }
    assert.deepStrictEqual(offenders, [], `Legacy schema awareness 仅允许 approved 边界，越界：${offenders.join(', ')}`);
    // 现代核心显式零知识（blocking）。
    const mustBeClean = [
      'stores/chatStore.ts',
      'lib/client/chatArtifactState.ts',
      'lib/client/storyArtifactPromotion.ts',
      'lib/client/chatPromotionOrchestration.ts',
      'app/(main)/chat/components/MessageParts/StoryArtifactPart.tsx',
      'app/(main)/chat/components/ChatLayout/index.tsx',
      'app/(main)/chat/components/HistoryPanel/index.tsx',
      'app/(main)/chat/components/HistoryRecords/index.tsx',
      'app/(main)/chat/components/GenerationHistory/index.tsx',
      'app/(main)/chat/components/HistoryList/index.tsx',
      'lib/client/library.ts',
    ];
    for (const rel of mustBeClean) {
      const full = path.resolve(process.cwd(), rel);
      if (!fs.existsSync(full)) continue;
      const content = fs.readFileSync(full, 'utf8');
      assert.ok(!WIRE_RE.test(content), `${rel} 不得直读 wire 字面量`);
      assert.ok(!TYPE_RE.test(content), `${rel} 不得出现 Legacy 类型`);
      assert.ok(!DECODE_RE.test(content), `${rel} 不得出现 decoder`);
    }
    // M4-08 writer-purity 并存：对象构造仅允许 compatibility decoder。
    const prodRoots = ['app', 'lib/client', 'stores', 'components'];
    const allowlisted = new Set([path.resolve(process.cwd(), 'lib/client/chatStoryCompatibility.ts')]);
    const constructorRe = /type\s*:\s*['"]storyCard['"]/;
    const violations: string[] = [];
    const walk2 = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walk2(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const content = fs.readFileSync(full, 'utf8');
        if (!constructorRe.test(content)) continue;
        if (allowlisted.has(path.resolve(full))) continue;
        violations.push(path.relative(process.cwd(), full));
      }
    };
    for (const root of prodRoots) {
      walk2(path.resolve(process.cwd(), root));
    }
    assert.deepStrictEqual(violations, [], `构造点仅允许 decoder，违规：${violations.join(', ')}`);
    console.log('PASS: M4-09-11 allowlist');
  }

  console.log('\nALL LEGACY COMPATIBILITY CONTAINMENT UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = main()
  .then(() => {
    console.log('ALL LEGACY COMPATIBILITY CONTAINMENT UNIT TESTS PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('TEST FAILED:', err);
    process.exit(1);
  })
  .finally(() => {
    setPromotionCreateOverride(undefined);
    useChatStore.getState().reset();
  });

export default testPromise;
