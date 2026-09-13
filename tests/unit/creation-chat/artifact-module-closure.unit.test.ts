import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { LibraryCreateInput, StoryWorkDetailDTO } from '../../../lib/trpc/schemas/library';
import { parseYamlSubset } from '../../../scripts/check-test-catalog.mjs';
import {
  extractTextFromParts,
  isStoryArtifactPart,
  isStoryCardPart,
} from '../../../types/chat';
import type { ChatMessage, MessagePart, StoryCardPart } from '../../../types/chat';
import {
  decodeLegacyStoryCard,
  findLegacyPlayableStoryCard,
} from '../../../lib/client/chatStoryCompatibility';
import {
  assertNoNewLegacyStoryCardWrites,
} from '../../../lib/server/chatConversation';
import { TRPCError } from '../../../lib/trpc/init';
import {
  completeArtifact,
  createDraftArtifact,
  interruptArtifact,
  isAllowedTransition,
  markPromotionFailed,
  markPromotionSuccess,
  startPromotion,
} from '../../../lib/client/chatArtifactState';

// 中文注释：M4-10 End-to-End Closure / Contract Freeze 回归（E2E-08-10）。
// 不再设计新能力：只证明 M4-01～09 的架构在组合运行时仍然成立，并把契约永久写进测试。
// 本 suite 是组合测试——每节都构造单项测试没有单独证明过的组合链（creation→ready→history、
// failure→retry→persistence、stale/reset、crash-window、History UI×live attempt、Legacy×Modern 共存），
// 复用真实 chatStore + chatArtifactState + promotion orchestration override + history codec +
// compatibility helpers；网络/DB 边界 stub；服务端 provenance 由 M4-08 L2 继续负责，此处只做对称抽查。
// 全程内存打桩，不建 socket、不绑端口，不碰 prisma/dev.db。
// 本文件覆盖 M4-10-01～11；M4-10-12 为同一 HEAD 上的 release-style 全量复跑，由送审门执行。

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

// 中文注释：先占桩——GlassToast / 会话落库（fetch/save 可控）/ Agent 交互计数，必须在 require chatStore 之前占位。
const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
nodeRequire.cache[glassToastPath] = {
  id: glassToastPath,
  filename: glassToastPath,
  loaded: true,
  exports: { default: { show: () => {}, clear: () => {} } },
} as unknown as NodeModule;

type DtoLike = {
  messageId: string;
  role: string;
  content: string;
  parts?: Array<Record<string, unknown>>;
  agentType?: string;
  createdAt?: string;
};

let stubFetchRows: DtoLike[] = [];
let fetchCount = 0;
let saveCalls: DtoLike[][] = [];

const chatConversationPath = path.resolve(process.cwd(), 'lib/client/chatConversation.ts');
nodeRequire.cache[chatConversationPath] = {
  id: chatConversationPath,
  filename: chatConversationPath,
  loaded: true,
  exports: {
    fetchMyConversation: async () => {
      fetchCount += 1;
      return stubFetchRows.map((r) => ({
        ...r,
        parts: r.parts ? JSON.parse(JSON.stringify(r.parts)) : undefined,
      }));
    },
    saveMyConversation: async (messages: DtoLike[]) => {
      saveCalls.push(JSON.parse(JSON.stringify(messages)) as DtoLike[]);
      return { ok: true };
    },
  },
} as unknown as NodeModule;

let agentInteractCalls = 0;
const agentFlowPath = path.resolve(process.cwd(), 'app/services/agentFlow.ts');
nodeRequire.cache[agentFlowPath] = {
  id: agentFlowPath,
  filename: agentFlowPath,
  loaded: true,
  exports: {
    interactWithAgent: async () => {
      agentInteractCalls += 1;
      return {};
    },
    summarizeContext: async () => '探针摘要-M410',
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

const historyModule = nodeRequire('../../../lib/client/chatArtifactHistory') as {
  canonicalizeArtifactForHistory: typeof import('../../../lib/client/chatArtifactHistory').canonicalizeArtifactForHistory;
  serializePartsForHistory: typeof import('../../../lib/client/chatArtifactHistory').serializePartsForHistory;
  rehydrateServerMessages: typeof import('../../../lib/client/chatArtifactHistory').rehydrateServerMessages;
  HISTORY_RELOAD_INTERRUPTED_REASON: typeof import('../../../lib/client/chatArtifactHistory').HISTORY_RELOAD_INTERRUPTED_REASON;
  HISTORY_RELOAD_PROMOTION_FAILED_ERROR: typeof import('../../../lib/client/chatArtifactHistory').HISTORY_RELOAD_PROMOTION_FAILED_ERROR;
};

type DispatchArg = Parameters<ReturnType<typeof useChatStore.getState>['dispatch']>[0];
type ChatMsg = ReturnType<typeof useChatStore.getState>['messages'][number];
interface ArtifactView {
  status: string;
  id: string;
  sourceMessageId: string;
  storyText: string;
  title?: unknown;
  prompt?: unknown;
  voiceId?: unknown;
  storyWorkId?: unknown;
  error?: unknown;
  reason?: unknown;
  createdAt: string;
  updatedAt: string;
}

const NOW = '2026-09-12T10:00:00.000Z';

// 中文注释：可控 deferred promotion 桩——kick 同步记录，结算由测试显式 resolve/reject。
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

function resetAll(): void {
  useChatStore.getState().reset();
  useChatStore.setState({ syncEnabled: false });
  stubFetchRows = [];
  fetchCount = 0;
  saveCalls = [];
  createCalls = [];
  pendingCreates = [];
  agentInteractCalls = 0;
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
    createdAt: NOW,
    updatedAt: NOW,
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

function submitStory(content: string, snapshots?: { promptSnapshot?: string; voiceSnapshot?: string }): string {
  useChatStore.getState().dispatch({
    type: 'user.submit',
    content,
    promptSnapshot: snapshots?.promptSnapshot ?? content,
    voiceSnapshot: snapshots?.voiceSnapshot,
  } as DispatchArg);
  const assistantId = useChatStore.getState().selectors.latestAssistantMessage()?.id;
  assert.ok(assistantId, 'assistant 占位必须存在');
  return assistantId as string;
}

function getMessage(id: string): ChatMsg | undefined {
  return useChatStore.getState().messages.find((m) => m.id === id);
}

function getArtifact(id: string): { msg: ChatMsg; artifact: ArtifactView } {
  const msg = getMessage(id);
  assert.ok(msg, `消息必须存在: ${id}`);
  const part = (msg as ChatMsg).parts?.find((p) => p.type === 'storyArtifact') as
    | { type: 'storyArtifact'; artifact: ArtifactView }
    | undefined;
  assert.ok(part, `消息必须持有 storyArtifact: ${id}`);
  return { msg: msg as ChatMsg, artifact: part.artifact };
}

function intentStory(id: string): void {
  useChatStore.getState().dispatch({ type: 'stream.intent', intent: 'Story', messageId: id } as DispatchArg);
}

function delta(id: string, content: string): void {
  useChatStore.getState().dispatch({ type: 'stream.delta', content, messageId: id } as DispatchArg);
}

function storyComplete(id: string, storyText: string): void {
  useChatStore.getState().dispatch({ type: 'stream.story_complete', messageId: id, storyText } as DispatchArg);
}

function finish(id: string): void {
  useChatStore.getState().dispatch({
    type: 'stream.finish',
    payload: { type: 'done', finishReason: 'stop' },
    messageId: id,
  } as DispatchArg);
}

function promotionRetry(id: string): void {
  useChatStore.getState().dispatch({ type: 'promotion.retry', messageId: id } as DispatchArg);
}

/** 中文注释：把当前内存会话经 history canonicalization 转为服务端 DTO 行（snapshot 口径）。 */
function snapshotToDtoRows(): DtoLike[] {
  return useChatStore.getState().messages.map((m) => {
    const parts = historyModule.serializePartsForHistory(m.parts as MessagePart[] | undefined) as unknown as
      | Array<Record<string, unknown>>
      | undefined;
    const row: DtoLike = {
      messageId: m.id,
      role: m.role,
      content: m.content,
      createdAt: typeof m.createdAt === 'string' ? m.createdAt : NOW,
    };
    if (parts !== undefined) {
      row.parts = JSON.parse(JSON.stringify(parts)) as Array<Record<string, unknown>>;
    }
    return row;
  });
}

/**
 * 中文注释：模拟进程重启 reload——清空内存后经 initForUser 从给定行恢复（restore-only 零副作用断言由各节负责）。
 */
async function reloadFromRows(rows: DtoLike[]): Promise<void> {
  useChatStore.getState().reset();
  useChatStore.setState({ syncEnabled: false });
  createCalls = [];
  pendingCreates = [];
  stubFetchRows = JSON.parse(JSON.stringify(rows)) as DtoLike[];
  fetchCount = 0;
  saveCalls = [];
  await useChatStore.getState().initForUser();
}

function readSource(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
}

async function main(): Promise<void> {
  console.log('=== M4-10-01: Fresh creation full-chain（主 happy-path seal） ===');
  {
    resetAll();
    const PROMPT = '给五岁的孩子讲一个深海小潜航员的故事';
    const VOICE = 'voice-frozen-closure-01';
    const FULL = '深海之下，小潜航员点亮了灯，神秘文明为他让开了一条路。';
    const assistantId = submitStory(PROMPT, { promptSnapshot: PROMPT, voiceSnapshot: VOICE });
    const draftBefore = getArtifact(assistantId).artifact;
    assert.strictEqual(draftBefore.status, 'draft');
    assert.strictEqual(draftBefore.sourceMessageId, assistantId);
    assert.strictEqual(draftBefore.prompt, PROMPT);
    assert.strictEqual(draftBefore.voiceId, VOICE);
    // 解耦封印前半：done 先到不提前 complete（story_complete != delivery done）。
    finish(assistantId);
    assert.strictEqual(getArtifact(assistantId).artifact.status, 'draft', 'done 不得提前 complete');
    assert.strictEqual(createCalls.length, 0, 'done 不得 kick promotion');
    assert.strictEqual(getMessage(assistantId)?.status, 'delivered', 'done 只结束 transport');
    intentStory(assistantId);
    delta(assistantId, '深海之下，');
    delta(assistantId, '小潜航员点亮了灯，神秘文明为他让开了一条路。');
    storyComplete(assistantId, FULL);
    const promoting = getArtifact(assistantId);
    assert.strictEqual(promoting.artifact.status, 'promoting');
    assert.strictEqual(createCalls.length, 1, 'story_complete 必须恰好 kick 一次 create');
    assert.deepStrictEqual(createCalls[0], {
      title: undefined,
      prompt: PROMPT,
      storyText: FULL,
      voiceId: VOICE,
      sourceMessageId: assistantId,
    });
    assert.strictEqual(promoting.msg.content, FULL, '终态 content 与 Artifact 同步');
    pendingCreates[0].resolve(makeDto(1001, pendingCreates[0].input));
    await flush();
    const ready = getArtifact(assistantId);
    assert.strictEqual(ready.artifact.status, 'ready');
    assert.strictEqual(ready.artifact.storyWorkId, 1001);
    assert.strictEqual(ready.artifact.sourceMessageId, assistantId, 'sourceMessageId 全程不变');
    assert.strictEqual(ready.artifact.storyText, FULL, 'storyText 不变');
    assert.strictEqual(ready.artifact.prompt, PROMPT, 'prompt snapshot 不变');
    assert.strictEqual(ready.artifact.voiceId, VOICE, 'voice snapshot 不变');
    const readyArtifactId = ready.artifact.id;
    // Modern-only：新链 StoryCard write = 0。
    const flat = JSON.stringify(useChatStore.getState().messages);
    assert.ok(!flat.includes('"type":"storyCard"'), '新创作链 StoryCard write 必须为 0');
    assert.ok(!flat.includes('storyCard'), '运行时不得出现 storyCard 写入');
    // ready != audio ready：Artifact 无 audioUrl，不携带任何播放语义。
    assert.ok(!('audioUrl' in (ready.artifact as unknown as Record<string, unknown>)), 'ready Artifact 不得有 audioUrl');
    // snapshot → reload → ready(storyWorkId) 精确保留。
    const rows = snapshotToDtoRows();
    await reloadFromRows(rows);
    assert.strictEqual(fetchCount, 1, 'reload 拉取一次服务端快照');
    const revived = getArtifact(assistantId);
    assert.strictEqual(revived.artifact.status, 'ready', 'reload 后仍为 ready');
    assert.strictEqual(revived.artifact.storyWorkId, 1001, 'storyWorkId 精确保留');
    assert.strictEqual(revived.artifact.id, readyArtifactId, 'artifact id 不变');
    assert.strictEqual(revived.artifact.sourceMessageId, assistantId, 'sourceMessageId 不变');
    assert.strictEqual(revived.artifact.storyText, FULL, 'storyText 不变');
    assert.strictEqual(revived.artifact.prompt, PROMPT, 'prompt 不变');
    assert.strictEqual(revived.artifact.voiceId, VOICE, 'voice 不变');
    assert.strictEqual(revived.msg.content, FULL, 'content 与 Artifact 同步');
    assert.strictEqual(createCalls.length, 0, 'reload create = 0');
    assert.strictEqual(pendingCreates.length, 0, 'reload 不 kick promotion');
    assert.strictEqual(agentInteractCalls, 0, 'reload generation = 0');
    assert.strictEqual(saveCalls.length, 0, 'restore 不 save-back');
    console.log('PASS: M4-10-01 full-chain seal');
  }

  console.log('=== M4-10-02: Promotion failure / retry / ready / reload 贯通 ===');
  {
    resetAll();
    const PROMPT = '重试链 prompt-02';
    const FULL = '失败后重试的完整正文-02';
    const assistantId = submitStory(PROMPT, { promptSnapshot: PROMPT, voiceSnapshot: 'voice-02' });
    intentStory(assistantId);
    delta(assistantId, '草稿-02');
    storyComplete(assistantId, FULL);
    assert.strictEqual(createCalls.length, 1);
    // 中文注释：浅拷贝保留 title: undefined（JSON 往返会丢 undefined 键，导致与 retry input 不可比）。
    const firstInput = { ...createCalls[0] };
    pendingCreates[0].reject(new Error('NETWORK_BOOM-4102'));
    await flush();
    const failed = getArtifact(assistantId);
    assert.strictEqual(failed.artifact.status, 'promotion_failed');
    assert.strictEqual(failed.artifact.storyText, FULL);
    assert.strictEqual(failed.artifact.sourceMessageId, assistantId);
    const failedArtifactId = failed.artifact.id;
    // snapshot / reload → promotion_failed（显式 reconciliation 前不动）。
    const rows = snapshotToDtoRows();
    await reloadFromRows(rows);
    const revived = getArtifact(assistantId);
    assert.strictEqual(revived.artifact.status, 'promotion_failed', 'reload 后仍为 promotion_failed');
    assert.strictEqual(revived.artifact.id, failedArtifactId, 'artifact id 不换');
    assert.strictEqual(revived.artifact.sourceMessageId, assistantId, 'sourceMessageId 不换');
    assert.strictEqual(revived.artifact.storyText, FULL, 'storyText 不换');
    assert.strictEqual(createCalls.length, 0, 'reload 不自动 retry');
    assert.strictEqual(useChatStore.getState().selectors.latestAssistantMessage()?.id, assistantId, 'assistant id 不换');
    // 用户显式 promotion.retry → only library.create。
    const messagesBefore = useChatStore.getState().messages.length;
    promotionRetry(assistantId);
    assert.strictEqual(getArtifact(assistantId).artifact.status, 'promoting');
    assert.strictEqual(createCalls.length, 1, 'retry 后 create exactly once');
    assert.deepStrictEqual(createCalls[0], firstInput, 'retry input 与首次逐字段一致');
    assert.strictEqual(useChatStore.getState().messages.length, messagesBefore, 'generation transport retry = 0（不新增 attempt）');
    assert.strictEqual(useChatStore.getState().selectors.latestAssistantMessage()?.id, assistantId);
    pendingCreates[0].resolve(makeDto(1002, pendingCreates[0].input));
    await flush();
    const ready = getArtifact(assistantId);
    assert.strictEqual(ready.artifact.status, 'ready');
    assert.strictEqual(ready.artifact.storyWorkId, 1002);
    assert.strictEqual(ready.artifact.sourceMessageId, assistantId);
    // ready 后再 reload → ready。
    const rows2 = snapshotToDtoRows();
    await reloadFromRows(rows2);
    const revived2 = getArtifact(assistantId);
    assert.strictEqual(revived2.artifact.status, 'ready');
    assert.strictEqual(revived2.artifact.storyWorkId, 1002);
    assert.strictEqual(agentInteractCalls, 0, '全程 generation = 0');
    console.log('PASS: M4-10-02 failure/retry/persistence chain');
  }

  console.log('=== M4-10-03: Pre-complete interruption closure ===');
  {
    // abort 变体。
    resetAll();
    const abortId = submitStory('中断前用例-abort-4103');
    intentStory(abortId);
    delta(abortId, '未完成草稿');
    useChatStore.getState().dispatch({ type: 'stream.abort', messageId: abortId, reason: 'aborted' } as DispatchArg);
    assert.strictEqual(getArtifact(abortId).artifact.status, 'interrupted');
    assert.strictEqual(createCalls.length, 0, 'abort before complete 不得 kick');
    // fail 变体。
    const failId = submitStory('中断前用例-fail-4103');
    intentStory(failId);
    delta(failId, '未完成草稿-fail');
    useChatStore.getState().dispatch({ type: 'stream.fail', error: 'net-4103', messageId: failId } as DispatchArg);
    assert.strictEqual(getArtifact(failId).artifact.status, 'interrupted');
    assert.strictEqual(createCalls.length, 0, 'fail before complete 不得 kick');
    // 中断后迟到的 story_complete 不得复活。
    storyComplete(abortId, '迟到正文-不得覆盖');
    assert.strictEqual(getArtifact(abortId).artifact.status, 'interrupted');
    assert.strictEqual(createCalls.length, 0);
    // reload = interrupted（两条皆然）。
    const rows = snapshotToDtoRows();
    await reloadFromRows(rows);
    assert.strictEqual(getArtifact(abortId).artifact.status, 'interrupted', 'reload 后仍 interrupted');
    assert.strictEqual(getArtifact(failId).artifact.status, 'interrupted', 'reload 后仍 interrupted');
    assert.strictEqual(createCalls.length, 0, 'reload create = 0');
    assert.strictEqual(pendingCreates.length, 0);
    console.log('PASS: M4-10-03 pre-complete interruption');
  }

  console.log('=== M4-10-04: Late terminal after complete 不倒退 ===');
  {
    resetAll();
    const assistantId = submitStory('late-terminal-4104');
    intentStory(assistantId);
    delta(assistantId, '草稿-04');
    storyComplete(assistantId, '完整正文-04');
    finish(assistantId);
    assert.strictEqual(getArtifact(assistantId).artifact.status, 'promoting', 'done 不倒退 promoting');
    useChatStore.getState().dispatch({ type: 'stream.fail', error: 'late-fail-04', messageId: assistantId } as DispatchArg);
    assert.strictEqual(getArtifact(assistantId).artifact.status, 'promoting', 'fail 不得倒退 promoting');
    useChatStore.getState().dispatch({ type: 'stream.abort', messageId: assistantId, reason: 'late-abort-04' } as DispatchArg);
    assert.strictEqual(getArtifact(assistantId).artifact.status, 'promoting', 'abort 不得倒退 promoting');
    assert.strictEqual(createCalls.length, 1, '在途 promotion 不得被取消/重发');
    pendingCreates[0].resolve(makeDto(1004, pendingCreates[0].input));
    await flush();
    assert.strictEqual(getArtifact(assistantId).artifact.status, 'ready');
    finish(assistantId);
    useChatStore.getState().dispatch({ type: 'stream.fail', error: 'late-fail-04b', messageId: assistantId } as DispatchArg);
    useChatStore.getState().dispatch({ type: 'stream.abort', messageId: assistantId, reason: 'late-abort-04b' } as DispatchArg);
    assert.strictEqual(getArtifact(assistantId).artifact.status, 'ready', 'ready 终态不得被后续 stream 事件倒退');
    assert.strictEqual(getArtifact(assistantId).artifact.storyWorkId, 1004);
    assert.strictEqual(createCalls.length, 1, '终态不得产生新的 create');
    console.log('PASS: M4-10-04 no regression after complete');
  }

  console.log('=== M4-10-05: Cross-attempt stale closure（reset + late settlement no-op） ===');
  {
    // resolve-late 变体：A promoting 在途 → reset → B 全链 ready → A resolve late 必须 no-op。
    resetAll();
    const idA = submitStory('A-完整正文-4105', { promptSnapshot: 'A-prompt' });
    intentStory(idA);
    delta(idA, 'A-草稿');
    storyComplete(idA, 'A-完整正文-4105');
    assert.strictEqual(createCalls.length, 1);
    assert.strictEqual(getArtifact(idA).artifact.status, 'promoting');
    useChatStore.getState().resetChat();
    assert.strictEqual(useChatStore.getState().messages.length, 0, 'reset 清空会话并作废在途 epoch');
    const idB = submitStory('B-完整正文-4105', { promptSnapshot: 'B-prompt' });
    assert.ok(idB !== idA, 'B 必须是全新 attempt 身份');
    intentStory(idB);
    delta(idB, 'B-草稿');
    storyComplete(idB, 'B-完整正文-4105');
    assert.strictEqual(createCalls.length, 2, 'B 独立 kick 自己的 promotion');
    assert.strictEqual(createCalls[1].sourceMessageId, idB, 'B 的幂等身份属于 B');
    pendingCreates[1].resolve(makeDto(222, pendingCreates[1].input));
    await flush();
    const readyB = getArtifact(idB);
    assert.strictEqual(readyB.artifact.status, 'ready');
    assert.strictEqual(readyB.artifact.storyWorkId, 222);
    // A resolve late（旧 token/epoch）：必须 no-op，B 不受污染。
    pendingCreates[0].resolve(makeDto(111, pendingCreates[0].input));
    await flush();
    assert.strictEqual(getMessage(idA), undefined, 'A 不得复活');
    const stillB = getArtifact(idB);
    assert.strictEqual(stillB.artifact.status, 'ready', 'B 不受 A 晚到污染');
    assert.strictEqual(stillB.artifact.storyWorkId, 222, 'A 的 storyWorkId 不得写到 B');
    assert.strictEqual(stillB.artifact.sourceMessageId, idB, 'B 身份完整');
    assert.strictEqual(stillB.artifact.storyText, 'B-完整正文-4105', 'B 正文完整');
    assert.strictEqual(createCalls.length, 2, '晚到 settlement 不得产生新的 create');
    assert.strictEqual(useChatStore.getState().messages.length, 2, '不得增殖消息');

    // reject-late 变体：A promoting 在途 → reset → B draft → A reject late 必须 no-op。
    resetAll();
    const idC = submitStory('C-完整正文-4105', { promptSnapshot: 'C-prompt' });
    intentStory(idC);
    delta(idC, 'C-草稿');
    storyComplete(idC, 'C-完整正文-4105');
    useChatStore.getState().resetChat();
    const idD = submitStory('D-故事-4105');
    assert.ok(idD !== idC);
    pendingCreates[0].reject(new Error('STALE-REJECT-4105'));
    await flush();
    assert.strictEqual(getMessage(idC), undefined, 'C reject 不得复活 C');
    const draftD = getArtifact(idD);
    assert.strictEqual(draftD.artifact.status, 'draft', 'C reject 不得污染 D');
    assert.strictEqual(draftD.artifact.sourceMessageId, idD, 'D 身份完整');
    console.log('PASS: M4-10-05 cross-attempt stale closure');
  }

  console.log('=== M4-10-06: Crash-window reconciliation（transient→durable + 仅显式 retry） ===');
  {
    resetAll();
    const draftRow: DtoLike = {
      messageId: 'crash-draft-06',
      role: 'assistant',
      content: '部分正文-06',
      parts: [{ type: 'storyArtifact', artifact: {
        id: 'artifact-crash-draft-06', artifactType: 'story', status: 'draft',
        sourceMessageId: 'crash-draft-06', storyText: '部分正文-06',
        prompt: 'prompt-快照-06', voiceId: 'voice-06', createdAt: NOW, updatedAt: NOW,
      } }],
      createdAt: NOW,
    };
    const completeRow: DtoLike = {
      messageId: 'crash-complete-06',
      role: 'assistant',
      content: '完整正文-06',
      parts: [{ type: 'storyArtifact', artifact: {
        id: 'artifact-crash-complete-06', artifactType: 'story', status: 'complete',
        sourceMessageId: 'crash-complete-06', storyText: '完整正文-06',
        prompt: 'prompt-快照-06', voiceId: 'voice-06', createdAt: NOW, updatedAt: NOW,
      } }],
      createdAt: NOW,
    };
    const promotingRow: DtoLike = {
      messageId: 'crash-promoting-06',
      role: 'assistant',
      content: '完整正文-06',
      parts: [{ type: 'storyArtifact', artifact: {
        id: 'artifact-crash-promoting-06', artifactType: 'story', status: 'promoting',
        sourceMessageId: 'crash-promoting-06', storyText: '完整正文-06',
        prompt: 'prompt-快照-06', voiceId: 'voice-06', createdAt: NOW, updatedAt: NOW,
      } }],
      createdAt: NOW,
    };
    stubFetchRows = [draftRow, completeRow, promotingRow];
    await useChatStore.getState().initForUser();
    assert.strictEqual(getArtifact('crash-draft-06').artifact.status, 'interrupted', 'draft → interrupted');
    assert.strictEqual(
      getArtifact('crash-draft-06').artifact.reason,
      historyModule.HISTORY_RELOAD_INTERRUPTED_REASON,
      'interrupted reason deterministic',
    );
    assert.strictEqual(getArtifact('crash-complete-06').artifact.status, 'promotion_failed', 'complete → promotion_failed');
    assert.strictEqual(getArtifact('crash-promoting-06').artifact.status, 'promotion_failed', 'promoting → promotion_failed');
    assert.strictEqual(getArtifact('crash-complete-06').artifact.storyText, '完整正文-06', '正文保留');
    assert.strictEqual(getArtifact('crash-complete-06').artifact.sourceMessageId, 'crash-complete-06');
    assert.strictEqual(createCalls.length, 0, 'reload create = 0');
    assert.strictEqual(pendingCreates.length, 0, 'reload kick = 0');
    assert.strictEqual(agentInteractCalls, 0, 'reload generation = 0');
    await flush();
    assert.strictEqual(getArtifact('crash-complete-06').artifact.status, 'promotion_failed', '禁止自动 retry（静置仍失败态）');
    assert.strictEqual(pendingCreates.length, 0, '静置不得产生 create');
    // interrupted 上的 retry 一律忽略（非 promotion_failed 不可重试）。
    promotionRetry('crash-draft-06');
    assert.strictEqual(getArtifact('crash-draft-06').artifact.status, 'interrupted');
    assert.strictEqual(createCalls.length, 0, 'interrupted retry 不得 create');
    // 只有显式 promotion.retry 可以继续：ex-complete 走 M2 幂等 reconciliation。
    promotionRetry('crash-complete-06');
    assert.strictEqual(getArtifact('crash-complete-06').artifact.status, 'promoting');
    assert.strictEqual(createCalls.length, 1, '显式 retry 恰好一次 create');
    assert.deepStrictEqual(createCalls[0], {
      title: undefined,
      prompt: 'prompt-快照-06',
      storyText: '完整正文-06',
      voiceId: 'voice-06',
      sourceMessageId: 'crash-complete-06',
    }, 'retry 消费 crash 前冻结快照，不猜 prompt');
    pendingCreates[0].resolve(makeDto(1006, pendingCreates[0].input));
    await flush();
    const reconciled = getArtifact('crash-complete-06');
    assert.strictEqual(reconciled.artifact.status, 'ready');
    assert.strictEqual(reconciled.artifact.storyWorkId, 1006);
    console.log('PASS: M4-10-06 crash-window reconciliation');
  }

  console.log('=== M4-10-07: History prompt while live attempt（排队 + exactly-once） ===');
  {
    resetAll();
    const idA = submitStory('A-故事-4107', { promptSnapshot: 'A-prompt-07' });
    // A live（sending/draft）时选择历史 prompt B：只写 pending，不碰 A。
    useChatStore.getState().setPendingAutoSend('B-历史提示词');
    const liveA = getArtifact(idA);
    assert.strictEqual(liveA.artifact.status, 'draft', 'A 不 abort');
    assert.strictEqual(liveA.msg.status, 'sending', 'A 不 reset');
    assert.strictEqual(useChatStore.getState().messages.length, 2, 'B 不发送');
    assert.strictEqual(useChatStore.getState().pendingAutoSend, 'B-历史提示词', 'pendingAutoSend = B');
    assert.strictEqual(createCalls.length, 0, '选择瞬间不 kick promotion');
    // 连续选择单 slot 覆盖（不做 queue）。
    useChatStore.getState().setPendingAutoSend('C-历史提示词');
    assert.strictEqual(useChatStore.getState().pendingAutoSend, 'C-历史提示词');
    assert.strictEqual(useChatStore.getState().messages.length, 2, '覆盖不发送');
    // promoting 中选择同样不干扰。
    intentStory(idA);
    delta(idA, 'A-草稿');
    storyComplete(idA, 'A-完整正文-4107');
    assert.strictEqual(getArtifact(idA).artifact.status, 'promoting');
    assert.strictEqual(useChatStore.getState().pendingAutoSend, 'C-历史提示词', 'promoting 中 pending 保留');
    assert.strictEqual(createCalls.length, 1, 'A 独立 promotion');
    pendingCreates[0].resolve(makeDto(100, pendingCreates[0].input));
    await flush();
    const settledA = getArtifact(idA);
    assert.strictEqual(settledA.artifact.status, 'ready', 'A settlement 归属正确');
    assert.strictEqual(settledA.artifact.storyWorkId, 100);
    // store 从不自动消费 pending（消费是 ChatLayout 唯一 effect 的职责）。
    assert.strictEqual(useChatStore.getState().pendingAutoSend, 'C-历史提示词', 'A terminal 后 pending 仍在，待消费');
    // 模拟 ChatLayout 唯一 consumer：clean creation（resetChat）+ 清 pending + 提交一次。
    const pending = useChatStore.getState().pendingAutoSend as string;
    useChatStore.getState().resetChat();
    useChatStore.getState().setPendingAutoSend(null);
    const idB = submitStory(pending, { promptSnapshot: pending });
    assert.ok(idB !== idA, 'B 是全新 attempt');
    assert.strictEqual(useChatStore.getState().pendingAutoSend, null, '消费后 pending 清空');
    const userMsgs = useChatStore.getState().messages.filter((m) => m.role === 'user' && m.content === pending);
    assert.strictEqual(userMsgs.length, 1, 'B exactly-once 启动');
    assert.strictEqual(getArtifact(idB).artifact.prompt, pending, 'B 携带所选 prompt 快照');
    intentStory(idB);
    delta(idB, 'B-草稿');
    storyComplete(idB, 'B-完整正文-4107');
    assert.strictEqual(createCalls.length, 2, 'B 独立 promotion exactly once');
    pendingCreates[1].resolve(makeDto(101, pendingCreates[1].input));
    await flush();
    assert.strictEqual(getArtifact(idB).artifact.storyWorkId, 101);
    // History 开关数据纯洁（store 级）：pending 的置空往返不改变 messages/artifact。
    const before = JSON.stringify(useChatStore.getState().messages);
    useChatStore.getState().setPendingAutoSend('X-探测');
    useChatStore.getState().setPendingAutoSend(null);
    assert.strictEqual(JSON.stringify(useChatStore.getState().messages), before, 'pending 往返不改变 Artifact lifecycle');
    // HistoryPanel 开关是 React 纯 UI state（静态）：只经 onSelectPrompt/onClose 与 ChatLayout 协作。
    const layoutSource = readSource('app/(main)/chat/components/ChatLayout/index.tsx');
    assert.ok(layoutSource.includes('const [historyOpen, setHistoryOpen] = useState(false)'), 'History 开关必须是纯 UI state');
    const panelSource = readSource('app/(main)/chat/components/HistoryPanel/index.tsx');
    assert.ok(!panelSource.includes('chatArtifactHistory'), 'HistoryPanel 不得 import codec');
    assert.ok(!panelSource.includes('fetchMyConversation'), 'HistoryPanel 不得直读服务端历史');
    assert.ok(!panelSource.includes('useRouter') && !panelSource.includes('next/navigation'), 'HistoryPanel 不得跨页导航');
    console.log('PASS: M4-10-07 history queue + exactly-once');
  }

  console.log('=== M4-10-08: Modern + Legacy coexistence final seal ===');
  {
    resetAll();
    // 历史：old assistant → Legacy StoryCard（经真实 initForUser 恢复）。
    stubFetchRows = [{
      messageId: 'old-1',
      role: 'assistant',
      content: 'legacy-正文-4108',
      parts: [{ type: 'storyCard', storyText: 'legacy-正文-4108', audioUrl: '' }],
      createdAt: NOW,
    }];
    await useChatStore.getState().initForUser();
    const legacyMsg = getMessage('old-1');
    assert.ok(legacyMsg, 'Legacy 消息必须可读');
    assert.strictEqual(legacyMsg.parts?.[0]?.type, 'storyCard', 'Legacy 不被转 Artifact');
    // 现代：new assistant → Modern StoryArtifact 全链 ready。
    const idN = submitStory('现代故事-4108', { promptSnapshot: '现代-prompt-4108', voiceSnapshot: 'voice-4108' });
    intentStory(idN);
    delta(idN, '现代草稿');
    storyComplete(idN, '现代正文-4108');
    assert.strictEqual(createCalls.length, 1, 'Modern promotion 经 frozen 通道');
    assert.strictEqual(createCalls[0].sourceMessageId, idN, 'Modern 幂等身份属于新 attempt');
    pendingCreates[0].resolve(makeDto(555, pendingCreates[0].input));
    await flush();
    assert.strictEqual(getArtifact(idN).artifact.storyWorkId, 555);
    // 新创作 Modern-only：新消息对无 storyCard。
    const modernFlat = JSON.stringify([getMessage(idN)]);
    assert.ok(!modernFlat.includes('storyCard'), '新创作仍 Modern-only');
    // Legacy 可读取：decoder / 类型 / 文本口径。
    const card = (legacyMsg.parts as MessagePart[])[0];
    assert.strictEqual(isStoryCardPart(card), true, 'isStoryCardPart 保留');
    assert.strictEqual(extractTextFromParts(legacyMsg.parts), 'legacy-正文-4108', 'extract 取 storyText');
    const decoded = decodeLegacyStoryCard(JSON.parse(JSON.stringify(card)) as unknown);
    assert.ok(decoded !== null && decoded.type === 'storyCard');
    // Legacy renderer contract 仍存在 + compatibility playback 仍可用（store 级可播查找）。
    assert.ok(fs.existsSync(path.resolve(process.cwd(), 'app/(main)/chat/components/MessageParts/StoryCardPart.tsx')), 'Legacy renderer 必须存在');
    const playable = findLegacyPlayableStoryCard([
      { type: 'storyCard', storyText: 'legacy-正文-4108', audioUrl: 'https://audio/old-4108.mp3' },
    ] as MessagePart[]);
    assert.ok(playable && playable.storyText === 'legacy-正文-4108', 'compatibility playback 查找可用');
    const storyFlowSource = readSource('app/services/storyFlow.ts');
    assert.ok(storyFlowSource.includes('playStoryText'), 'compatibility playback 入口保留');
    // 同一恢复 conversation：mixed snapshot → reload，两者共存且互不转换。
    const rows = snapshotToDtoRows();
    await reloadFromRows(rows);
    const legacyRevived = getMessage('old-1');
    assert.ok(legacyRevived, 'reload 后 Legacy 仍在');
    assert.strictEqual(legacyRevived.parts?.[0]?.type, 'storyCard', 'reload 不转 Legacy');
    assert.strictEqual((legacyRevived.parts?.[0] as StoryCardPart).storyText, 'legacy-正文-4108');
    const modernRevived = getArtifact(idN);
    assert.strictEqual(modernRevived.artifact.status, 'ready', 'reload 后 Modern 仍 ready');
    assert.strictEqual(modernRevived.artifact.storyWorkId, 555);
    assert.strictEqual(modernRevived.artifact.storyText, '现代正文-4108');
    // 服务端对称抽查（细则归 M4-08 L2，此处只证明同一 guard 同一语义仍在）：
    // 已有 Legacy 可续存 / 可减少；new / mutated / duplicated / tuple-collision / no-baseline 一律 reject。
    const persisted = [{ messageId: 'old-1', parts: JSON.stringify([{ type: 'storyCard', storyText: 'legacy-正文-4108', audioUrl: '' }]) }];
    const same = [{ messageId: 'old-1', role: 'assistant', content: 'legacy-正文-4108', parts: [{ type: 'storyCard', storyText: 'legacy-正文-4108', audioUrl: '' }] }];
    assert.doesNotThrow(() => assertNoNewLegacyStoryCardWrites(persisted, same as never), '原样续存 PASS');
    assert.doesNotThrow(
      () => assertNoNewLegacyStoryCardWrites(persisted, [{ messageId: 'old-1', role: 'assistant', content: 'legacy-正文-4108', parts: [] }] as never),
      '删除（减少） PASS',
    );
    assert.throws(
      () => assertNoNewLegacyStoryCardWrites([], [{ messageId: 'new-legacy', role: 'assistant', content: 'N', parts: [{ type: 'storyCard', storyText: 'N', audioUrl: '' }] }] as never),
      (e: unknown) => e instanceof TRPCError && e.code === 'BAD_REQUEST',
      'new Legacy REJECT',
    );
    assert.throws(
      () => assertNoNewLegacyStoryCardWrites(persisted, [{ messageId: 'old-1', role: 'assistant', content: 'MUT', parts: [{ type: 'storyCard', storyText: 'MUT', audioUrl: '' }] }] as never),
      (e: unknown) => e instanceof TRPCError && e.code === 'BAD_REQUEST',
      'mutated Legacy REJECT',
    );
    assert.throws(
      () => assertNoNewLegacyStoryCardWrites(persisted, [{ messageId: 'old-1', role: 'assistant', content: 'legacy-正文-4108', parts: [{ type: 'storyCard', storyText: 'legacy-正文-4108', audioUrl: '' }, { type: 'storyCard', storyText: 'legacy-正文-4108', audioUrl: '' }] }] as never),
      (e: unknown) => e instanceof TRPCError && e.code === 'BAD_REQUEST',
      'duplicated Legacy REJECT',
    );
    const nulPersisted = [{ messageId: 'A', parts: JSON.stringify([{ type: 'storyCard', storyText: 'B\u0000C', audioUrl: '' }]) }];
    assert.throws(
      () => assertNoNewLegacyStoryCardWrites(nulPersisted, [{ messageId: 'A\u0000B', role: 'assistant', content: 'C', parts: [{ type: 'storyCard', storyText: 'C', audioUrl: '' }] }] as never),
      (e: unknown) => e instanceof TRPCError && e.code === 'BAD_REQUEST',
      'tuple collision REJECT',
    );
    // 同 tuple 精确续存仍 PASS（证明 guard 是 tuple 语义而非粗暴全拒）。
    assert.doesNotThrow(
      () => assertNoNewLegacyStoryCardWrites(nulPersisted, [{ messageId: 'A', role: 'assistant', content: 'B\u0000C', parts: [{ type: 'storyCard', storyText: 'B\u0000C', audioUrl: '' }] }] as never),
      '同 tuple 续存 PASS',
    );
    console.log('PASS: M4-10-08 coexistence seal');
  }

  console.log('=== M4-10-09: Modern playback exclusion final seal ===');
  {
    resetAll();
    const partSource = readSource('app/(main)/chat/components/MessageParts/StoryArtifactPart.tsx');
    for (const banned of ['playStoryText', 'playbackStore', 'audioUrl', '播放故事', '暂停播放', '继续收听', 'useFloatingPlayer', 'onPlayStory']) {
      assert.ok(!partSource.includes(banned), `StoryArtifactPart 不得出现 ${banned}`);
    }
    for (const required of ['正在创作故事', '已保存到作品库', '重试保存', '查看作品', '/library/']) {
      assert.ok(partSource.includes(required), `StoryArtifactPart 必须保留 lifecycle UI：${required}`);
    }
    // 行为：ready Artifact 无 audioUrl；ready 只做 Library handoff（href 语义在源码层已断言）。
    const readyLike = markPromotionSuccess(
      startPromotion(completeArtifact(createDraftArtifact({ sourceMessageId: 'pb-09', initialText: 'x' }), { finalStoryText: '正文-09' })),
      { storyWorkId: 909 },
    );
    assert.ok(!('audioUrl' in (readyLike as unknown as Record<string, unknown>)), 'ready Artifact 无 audioUrl');
    // Legacy renderer 的旧 playback 不受影响（exclusion 是 Modern-only）。
    const legacyPartSource = readSource('app/(main)/chat/components/MessageParts/StoryCardPart.tsx');
    assert.ok(legacyPartSource.includes('playStoryText'), 'Legacy renderer 保留 playStoryText');
    assert.ok(legacyPartSource.includes('播放故事'), 'Legacy renderer 保留播放文案');
    console.log('PASS: M4-10-09 playback exclusion');
  }

  console.log('=== M4-10-10: Frozen architecture audit（blocking） ===');
  {
    // ① Modern state module 无 Legacy。
    const stateSource = readSource('lib/client/chatArtifactState.ts');
    assert.ok(!/['"]storyCard['"]/.test(stateSource), 'chatArtifactState 无 wire 字面量');
    assert.ok(!stateSource.includes('StoryCardPart'), 'chatArtifactState 无 Legacy 类型');
    assert.ok(!stateSource.includes('decodeLegacyStoryCard'), 'chatArtifactState 无 decoder');
    // ② chatStore 无 Legacy wire 字面量，只经 helper。
    const storeSource = readSource('stores/chatStore.ts');
    assert.ok(!/['"]storyCard['"]/.test(storeSource), 'chatStore 无 wire 字面量');
    assert.ok(!storeSource.includes('StoryCardPart'), 'chatStore 无 Legacy 类型');
    assert.ok(storeSource.includes('chatStoryCompatibility'), 'chatStore 经 helper 查询');
    assert.ok(storeSource.includes('hasLegacyStoryCard'), 'intent 保护经 helper');
    assert.ok(storeSource.includes('hasAnyStoryPart'), 'isLatestMessage 经 helper');
    assert.ok(storeSource.includes('hasStoryContent'), 'hasStoryMessages 经 helper');
    assert.ok(storeSource.includes('findLegacyPlayableStoryCard'), 'nextStorySegment 经 helper');
    // ③ promotion 只经 frozen adapter/facade。
    const orchSource = readSource('lib/client/chatPromotionOrchestration.ts');
    assert.ok(orchSource.includes('promoteStoryArtifact'), '编排经唯一 adapter 通道');
    assert.ok(!orchSource.includes('libraryClient'), '编排不直调 libraryClient');
    assert.ok(!orchSource.includes('library.create'), '编排不直调 library.create');
    assert.ok(!orchSource.includes('lib/server'), '编排不 import server');
    assert.ok(!orchSource.includes('prisma'), '编排不 import prisma');
    assert.ok(!orchSource.includes('promotionToken'), 'token 不进编排持久语义');
    assert.ok(!storeSource.includes('library.create'), 'store 不直调 library.create');
    assert.ok(!storeSource.includes('storyArtifactPromotion'), 'store 不直引 adapter（经编排层）');
    assert.ok(storeSource.includes('promotionToken'), 'store 持有 transient token 守卫');
    assert.ok(storeSource.includes('promotionEpoch'), 'store 持有 epoch 守卫');
    assert.ok(storeSource.includes('inflightPromotions'), 'store 持有在途去重守卫');
    const adapterSource = readSource('lib/client/storyArtifactPromotion.ts');
    assert.ok(adapterSource.includes("from '@/lib/client/library'"), 'adapter 只消费 frozen facade');
    assert.ok(!adapterSource.includes('routers/'), 'adapter 不直引 server router');
    const flowSource = readSource('app/services/chatFlow.ts');
    assert.ok(!flowSource.includes('library.create'), 'chatFlow 不直调 library.create');
    assert.ok(!flowSource.includes('storyArtifactPromotion'), 'chatFlow 不直引 adapter');
    // ④ History codec mapping 不变 + live 状态机未为 recovery 开口子。
    assert.strictEqual(historyModule.HISTORY_RELOAD_INTERRUPTED_REASON, 'history_reload_interrupted');
    assert.strictEqual(historyModule.HISTORY_RELOAD_PROMOTION_FAILED_ERROR, 'history_reload_promotion_unknown');
    const draftOnly = createDraftArtifact({ sourceMessageId: 'audit-10', initialText: 'a' });
    assert.strictEqual(historyModule.canonicalizeArtifactForHistory(draftOnly).status, 'interrupted', 'draft→interrupted 冻结');
    const completedOnly = completeArtifact(createDraftArtifact({ sourceMessageId: 'audit-10b', initialText: 'x' }), { finalStoryText: 'xy' });
    assert.strictEqual(historyModule.canonicalizeArtifactForHistory(completedOnly).status, 'promotion_failed', 'complete→promotion_failed 冻结');
    assert.strictEqual(isAllowedTransition('complete', 'promotion_failed'), false, 'live 表未为 recovery 开口子');
    assert.strictEqual(isAllowedTransition('complete', 'promoting'), true);
    assert.strictEqual(isAllowedTransition('promotion_failed', 'promoting'), true);
    assert.strictEqual(isAllowedTransition('ready', 'promoting'), false, 'ready 终态冻结');
    assert.strictEqual(isAllowedTransition('interrupted', 'promoting'), false, 'interrupted 终态冻结');
    assert.throws(() => interruptArtifact(completedOnly as never), /非法状态转移/);
    // ⑤ History UI 无 raw history parsing。
    for (const rel of [
      'app/(main)/chat/components/HistoryPanel/index.tsx',
      'app/(main)/chat/components/HistoryRecords/index.tsx',
      'app/(main)/chat/components/GenerationHistory/index.tsx',
      'app/(main)/chat/components/HistoryList/index.tsx',
    ]) {
      const content = readSource(rel);
      assert.ok(!content.includes('chatArtifactHistory'), `${rel} 不得 import codec`);
      assert.ok(!content.includes('rehydrateServerMessages') && !content.includes('serializePartsForHistory'), `${rel} 不得 raw parse 历史`);
      assert.ok(!content.includes('fetchMyConversation') && !content.includes('saveMyConversation'), `${rel} 不得直调会话落库`);
      assert.ok(!content.includes('libraryClient'), `${rel} 不得直调 Library`);
      assert.ok(!content.includes('storyArtifactPromotion'), `${rel} 不得直引 promotion adapter`);
    }
    // ⑥ Legacy 新构造点仅 decoder（扫描整个 lib，含 lib/server；types/ 除外，见下）。
    const constructorRe = /type\s*:\s*['"]storyCard['"]/;
    const constructorViolations: string[] = [];
    const walkProd = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walkProd(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (path.resolve(full) === path.resolve(process.cwd(), 'lib/client/chatStoryCompatibility.ts')) continue;
        if (constructorRe.test(fs.readFileSync(full, 'utf8'))) {
          constructorViolations.push(path.relative(process.cwd(), full));
        }
      }
    };
    for (const root of ['app', 'lib', 'stores', 'components']) {
      walkProd(path.resolve(process.cwd(), root));
    }
    assert.deepStrictEqual(constructorViolations, [], `新构造点仅允许 decoder，违规：${constructorViolations.join(', ')}`);
    // 中文注释：M4-10 fixup——server provenance boundary 允许识别 Legacy，但绝不允许构造 Legacy。
    // chatConversation.ts 在 final allowlist（识别 existing storyCard 做 provenance/sanitize），
    // 故 allowlist 本身拦不住它新增构造点；此处显式断言堵住"新 Legacy 写入"通道。
    // （注：types/ 不进 constructor scan——StoryCardPart 类型声明的 type: 'storyCard' 合法，非运行时构造。）
    assert.ok(
      !constructorRe.test(readSource('lib/server/chatConversation.ts')),
      'server provenance boundary 允许识别 Legacy，但绝不允许构造 Legacy',
    );
    // ⑦ final allowlist 外 Legacy 依赖 = 0。
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
      'app/services/storyFlow.ts',
      'stores/playbackProgressStore.ts',
      // M5-09：PlaybackSessionStore 为 Draft rehydrate 合法 reader（storyCard/storyArtifact 双读，与旧 store 同权，M9 删除旧 store 后本项保留）。
      'stores/playbackSessionStore.ts',
      'app/(main)/chat/components/ChatLog/MessageBubble/index.tsx',
    ]);
    const offenders: string[] = [];
    const walkAllow = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walkAllow(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const rel = path.relative(process.cwd(), full);
        const content = fs.readFileSync(full, 'utf8');
        if (WIRE_RE.test(content) || TYPE_RE.test(content) || DECODE_RE.test(content)) {
          if (!approved.has(rel)) offenders.push(rel);
        }
      }
    };
    for (const root of ['app', 'lib', 'stores', 'components', 'types']) {
      walkAllow(path.resolve(process.cwd(), root));
    }
    assert.deepStrictEqual(offenders, [], `allowlist 外 Legacy 依赖必须为 0，越界：${offenders.join(', ')}`);
    // ⑧ Modern 核心零直接引用。
    for (const rel of [
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
    ]) {
      const full = path.resolve(process.cwd(), rel);
      if (!fs.existsSync(full)) continue;
      const content = fs.readFileSync(full, 'utf8');
      assert.ok(!WIRE_RE.test(content), `${rel} 无 wire 字面量`);
      assert.ok(!TYPE_RE.test(content), `${rel} 无 Legacy 类型`);
      assert.ok(!DECODE_RE.test(content), `${rel} 无 decoder`);
    }
    // ⑨ M2 facade surface 不变：8 procedures + libraryClient。
    const facadeSource = readSource('lib/client/library.ts');
    for (const name of ['list', 'get', 'create', 'rename', 'setFavorite', 'moveToTrash', 'restore', 'deletePermanently', 'libraryClient']) {
      assert.ok(facadeSource.includes(name), `facade 必须暴露 ${name}`);
    }
    const exportConsts = facadeSource.match(/export const \w+/g) ?? [];
    assert.strictEqual(exportConsts.length, 9, `facade surface 必须恰为 9 个导出（8 procedures + libraryClient），实际=${exportConsts.join(',')}`);
    console.log('PASS: M4-10-10 architecture audit');
  }

  console.log('=== M4-10-11: Catalog / docs consistency ===');
  {
    interface CatalogCase {
      case_id?: string;
      display_name_zh?: string;
      legacy_aliases?: string[];
      journey_id?: string;
      user_goal?: string;
      priority?: string;
      lifecycle_status?: string;
      spec_path?: string;
      executable_ids?: string[];
      owner?: string;
      risk_tags?: string[];
    }
    interface CatalogExec {
      executable_id?: string;
      layer?: string;
      path?: string;
    }
    const catalog = parseYamlSubset(
      fs.readFileSync(path.resolve(process.cwd(), 'tests/test-catalog.yaml'), 'utf8'),
    ) as unknown as { cases?: CatalogCase[]; executables?: CatalogExec[] };
    assert.ok(Array.isArray(catalog.cases) && catalog.cases.length > 0, 'catalog cases 非空');
    assert.ok(Array.isArray(catalog.executables) && catalog.executables.length > 0, 'catalog executables 非空');
    const execById = new Map((catalog.executables ?? []).map((e) => [e.executable_id, e]));
    // E2E-08-01～10 逐条存在：creation-artifact / P0 / ACTIVE / spec 落盘 / executable 落盘。
    for (let n = 1; n <= 10; n += 1) {
      const alias = `E2E-08-${String(n).padStart(2, '0')}`;
      const found: CatalogCase[] = (catalog.cases ?? []).filter((c) => (c.legacy_aliases ?? []).includes(alias));
      assert.strictEqual(found.length, 1, `${alias} 必须恰有一条 case`);
      const c: CatalogCase = found[0];
      assert.strictEqual(c.journey_id, 'creation-artifact', `${alias} journey 必须为 creation-artifact`);
      assert.strictEqual(c.priority, 'P0', `${alias} 必须为 P0`);
      assert.strictEqual(c.lifecycle_status, 'ACTIVE', `${alias} 必须为 ACTIVE`);
      assert.ok(c.spec_path && c.spec_path.startsWith('docs/e2e/08-创作Artifact/'), `${alias} spec 必须在 08 目录`);
      const specFile = String(c.spec_path).split('#')[0];
      assert.ok(fs.existsSync(path.resolve(process.cwd(), specFile)), `${alias} spec_path 必须落盘：${specFile}`);
      assert.ok(Array.isArray(c.executable_ids) && c.executable_ids.length > 0, `${alias} 必须绑定 executable`);
      for (const eid of c.executable_ids ?? []) {
        const exec = execById.get(eid);
        assert.ok(exec, `${alias} 引用的 ${eid} 必须在 executables 中定义（无 dangling）`);
        assert.ok(exec.path && fs.existsSync(path.resolve(process.cwd(), String(exec.path))), `${eid} path 必须落盘`);
      }
    }
    // E2E-08-10 本体：case_id / owner / closure 风险标签 / runner 注册。
    const closure = (catalog.cases ?? []).find((c) => c.case_id === 'artifact-module-end-to-end-closure');
    assert.ok(closure, '必须存在 artifact-module-end-to-end-closure');
    assert.ok((closure.legacy_aliases ?? []).includes('E2E-08-10'), 'closure 必须认领 E2E-08-10');
    assert.strictEqual(closure.owner, 'creation-artifact');
    assert.ok((closure.risk_tags ?? []).includes('closure'), 'closure 风险标签必须含 closure');
    assert.ok((closure.risk_tags ?? []).includes('contract'), 'closure 风险标签必须含 contract');
    assert.ok((closure.executable_ids ?? []).includes('exec-artifact-module-closure'), 'closure 必须绑定 exec-artifact-module-closure');
    const closureExec = execById.get('exec-artifact-module-closure');
    assert.ok(closureExec && closureExec.layer === 'L1', 'closure executable 必须为 L1');
    assert.ok(fs.existsSync(path.resolve(process.cwd(), String(closureExec.path))), 'closure executable path 必须落盘');
    const runnerSource = readSource('scripts/run-tests.mjs');
    assert.ok(runnerSource.includes('artifact-module-closure'), 'closure suite 必须注册进 runner（新增 suite，不发明新入口）');
    // contract matrix 与代码最终 invariant 一致（closure doc 含全部冻结锚点）。
    const closureDoc = readSource('docs/e2e/08-创作Artifact/10-EndToEndClosure.md');
    for (const anchor of [
      'story_complete', 'sourceMessageId', 'promotion_failed', 'promotion.retry', 'storyWorkId',
      'interrupted', 'promotion_failed', 'pendingAutoSend', 'allowlist', '幂等',
      'audio ready', 'Chat-owned', 'restore-only', 'assertNoNewLegacyStoryCardWrites', 'migration',
    ]) {
      assert.ok(closureDoc.includes(anchor), `closure doc 必须冻结锚点：${anchor}`);
    }
    // ACTIVE current-state 无已知过时的 Player-owned History 描述。
    const historyDoc = readSource('docs/e2e/02-交互并发与竞态防御/11-播放器选历史切换当前创作.md');
    assert.ok(!historyDoc.includes('从播放器'), '02-11 现役文档不得再写“从播放器”');
    assert.ok(!historyDoc.includes('播放器页'), '02-11 现役文档不得再写“播放器页”');
    assert.ok(!historyDoc.includes('播放器选历史'), '02-11 现役文档不得再写“播放器选历史”');
    assert.ok(
      historyDoc.includes('Chat-owned') || historyDoc.includes('回迁'),
      '02-11 现役文档必须说明 History 归 Chat',
    );
    const historyCase = (catalog.cases ?? []).find((c) => c.case_id === 'history-prompt-start-new-creation');
    assert.ok(historyCase, 'history-prompt case 必须存在');
    assert.ok(!String(historyCase.user_goal ?? '').includes('播放器'), 'history-prompt user_goal 不得带 Player ownership');
    console.log('PASS: M4-10-11 catalog/docs consistency');
  }

  console.log('\nALL ARTIFACT MODULE CLOSURE UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = main()
  .then(() => {
    console.log('ALL ARTIFACT MODULE CLOSURE UNIT TESTS PASSED SUCCESSFULLY!');
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
