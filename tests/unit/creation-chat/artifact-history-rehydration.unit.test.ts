import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { LibraryCreateInput, StoryWorkDetailDTO } from '../../../lib/trpc/schemas/library';

// 中文注释：M4-06 Artifact History Round-trip / Rehydration 回归（E2E-08-06）。
// 建立 History persistence boundary：transient 跨进程安全降级、stable 精确 round-trip、
// 脏数据 fail-closed、恢复纯读零副作用、await-window 本地 attempt 隔离。
// 全程内存打桩（fetch/save 可控、promotion create 可控 deferred、agent 计数），
// 不建 socket、不绑端口，不碰 prisma/dev.db。

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

// 中文注释：先占桩——GlassToast / 会话落库 / Agent 交互，必须在 require chatStore 之前占位。
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

// 中文注释：可变 fetch/save 桩——闭包捕获可变变量，逐节切换 fixture（不重写 exports 对象）。
let stubFetchRows: DtoLike[] = [];
let fetchImpl: (() => Promise<DtoLike[]>) | null = null;
let fetchCount = 0;
let saveCalls: Array<{ messages: DtoLike[]; baseMessageIds?: string[] }> = [];
let saveImpl: ((messages: DtoLike[], base?: string[]) => Promise<unknown>) | null = null;

const chatConversationPath = path.resolve(process.cwd(), 'lib/client/chatConversation.ts');
nodeRequire.cache[chatConversationPath] = {
  id: chatConversationPath,
  filename: chatConversationPath,
  loaded: true,
  exports: {
    fetchMyConversation: async () => {
      fetchCount += 1;
      if (fetchImpl) {
        return fetchImpl();
      }
      return stubFetchRows.map((r) => ({
        ...r,
        parts: r.parts ? r.parts.map((p) => JSON.parse(JSON.stringify(p))) : undefined,
      }));
    },
    saveMyConversation: async (messages: DtoLike[], baseMessageIds?: string[]) => {
      saveCalls.push({
        messages: JSON.parse(JSON.stringify(messages)) as DtoLike[],
        baseMessageIds: baseMessageIds ? [...baseMessageIds] : undefined,
      });
      if (saveImpl) {
        return saveImpl(messages, baseMessageIds);
      }
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
    summarizeContext: async () => '探针摘要-M406',
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
  rehydrateStoryArtifactPart: typeof import('../../../lib/client/chatArtifactHistory').rehydrateStoryArtifactPart;
  serializePartsForHistory: typeof import('../../../lib/client/chatArtifactHistory').serializePartsForHistory;
  rehydratePartsFromHistory: typeof import('../../../lib/client/chatArtifactHistory').rehydratePartsFromHistory;
  rehydrateMessageFromHistory: typeof import('../../../lib/client/chatArtifactHistory').rehydrateMessageFromHistory;
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
  fetchImpl = null;
  fetchCount = 0;
  saveCalls = [];
  saveImpl = null;
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

function draftArtifact(sourceId: string, overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: `artifact-${sourceId}`,
    artifactType: 'story',
    status: 'draft',
    sourceMessageId: sourceId,
    storyText: '部分正文-草稿',
    title: '标题-06',
    prompt: 'prompt-快照-06',
    voiceId: 'voice-06',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function completeArtifact(sourceId: string, overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: `artifact-${sourceId}`,
    artifactType: 'story',
    status: 'complete',
    sourceMessageId: sourceId,
    storyText: '完整正文-06',
    title: '标题-06',
    prompt: 'prompt-快照-06',
    voiceId: 'voice-06',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function promotingArtifact(sourceId: string, overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: `artifact-${sourceId}`,
    artifactType: 'story',
    status: 'promoting',
    sourceMessageId: sourceId,
    storyText: '完整正文-06',
    title: '标题-06',
    prompt: 'prompt-快照-06',
    voiceId: 'voice-06',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function readyArtifact(sourceId: string, overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: `artifact-${sourceId}`,
    artifactType: 'story',
    status: 'ready',
    storyWorkId: 123,
    sourceMessageId: sourceId,
    storyText: '完整正文-06',
    title: '标题-06',
    prompt: 'prompt-快照-06',
    voiceId: 'voice-06',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function failedArtifact(sourceId: string, overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: `artifact-${sourceId}`,
    artifactType: 'story',
    status: 'promotion_failed',
    sourceMessageId: sourceId,
    storyText: '完整正文-06',
    title: '标题-06',
    prompt: 'prompt-快照-06',
    voiceId: 'voice-06',
    error: 'NETWORK_BOOM-06',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function interruptedArtifact(sourceId: string, overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: `artifact-${sourceId}`,
    artifactType: 'story',
    status: 'interrupted',
    sourceMessageId: sourceId,
    storyText: '部分正文-中断',
    title: '标题-06',
    prompt: 'prompt-快照-06',
    voiceId: 'voice-06',
    reason: 'aborted',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function artifactDto(messageId: string, artifact: Record<string, unknown>, content?: string): DtoLike {
  return {
    messageId,
    role: 'assistant',
    content: content ?? String(artifact.storyText ?? ''),
    parts: [{ type: 'storyArtifact', artifact: JSON.parse(JSON.stringify(artifact)) }],
    createdAt: NOW,
  };
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

function getPartTypes(id: string): string[] {
  const msg = getMessage(id);
  assert.ok(msg, `消息必须存在: ${id}`);
  return ((msg as ChatMsg).parts ?? []).map((p) => p.type);
}

async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await Promise.resolve();
  await Promise.resolve();
}

async function main(): Promise<void> {
  console.log('=== M4-06-01: Ready exact round-trip ===');
  {
    resetAll();
    const sourceId = 'assistant-ready-01';
    const before = readyArtifact(sourceId);
    const parts = [{ type: 'storyArtifact', artifact: before }] as unknown as Parameters<
      typeof historyModule.serializePartsForHistory
    >[0];
    const serialized = historyModule.serializePartsForHistory(parts);
    assert.ok(serialized && serialized.length === 1, 'ready 序列化必须保留单 part');
    const persistedArtifact = (serialized[0] as { artifact: ArtifactView }).artifact;
    assert.strictEqual(persistedArtifact.status, 'ready', 'save-side ready 必须原样保留');
    assert.strictEqual(persistedArtifact.storyWorkId, 123);
    // 模拟 persisted payload → rehydrate（server DTO 口径）。
    const dto: DtoLike = {
      messageId: sourceId,
      role: 'assistant',
      content: String(before.storyText),
      parts: JSON.parse(JSON.stringify(serialized)) as Array<Record<string, unknown>>,
      createdAt: NOW,
    };
    const recovered = historyModule.rehydrateMessageFromHistory(dto);
    const recoveredPart = (recovered.parts?.find((p) => p.type === 'storyArtifact') ?? null) as unknown as {
      artifact: ArtifactView;
    } | null;
    assert.ok(recoveredPart, 'ready 必须恢复出 storyArtifact part');
    assert.strictEqual(recoveredPart.artifact.status, 'ready');
    assert.strictEqual(recoveredPart.artifact.storyWorkId, 123);
    assert.strictEqual(recoveredPart.artifact.id, before.id, 'id 不变');
    assert.strictEqual(recoveredPart.artifact.sourceMessageId, sourceId, 'sourceMessageId 不变');
    assert.strictEqual(recoveredPart.artifact.storyText, before.storyText, 'storyText 不变');
    assert.strictEqual(recoveredPart.artifact.prompt, before.prompt, 'prompt 不变');
    assert.strictEqual(recoveredPart.artifact.voiceId, before.voiceId, 'voice 不变');
    assert.strictEqual(recoveredPart.artifact.title, before.title, 'title 不变');
    assert.strictEqual(recoveredPart.artifact.createdAt, NOW, 'createdAt 不变');
    assert.strictEqual(recoveredPart.artifact.updatedAt, NOW, 'updatedAt 不变');
    assert.strictEqual(recovered.content, before.storyText, 'content 与 Artifact 同步');
    assert.strictEqual(createCalls.length, 0, 'rehydrate 不得 library.create');
    assert.strictEqual(agentInteractCalls, 0, 'rehydrate 不得 generation');
    console.log('PASS: M4-06-01 ready exact round-trip');
  }

  console.log('=== M4-06-02: Promotion failed exact round-trip ===');
  {
    resetAll();
    const sourceId = 'assistant-failed-02';
    const before = failedArtifact(sourceId);
    const parts = [{ type: 'storyArtifact', artifact: before }] as unknown as Parameters<
      typeof historyModule.serializePartsForHistory
    >[0];
    const serialized = historyModule.serializePartsForHistory(parts);
    assert.ok(serialized && serialized.length === 1);
    assert.strictEqual((serialized[0] as { artifact: ArtifactView }).artifact.status, 'promotion_failed');
    const dto: DtoLike = {
      messageId: sourceId,
      role: 'assistant',
      content: String(before.storyText),
      parts: JSON.parse(JSON.stringify(serialized)) as Array<Record<string, unknown>>,
      createdAt: NOW,
    };
    const recovered = historyModule.rehydrateMessageFromHistory(dto);
    const recoveredPart = (recovered.parts?.find((p) => p.type === 'storyArtifact') ?? null) as unknown as {
      artifact: ArtifactView;
    } | null;
    assert.ok(recoveredPart, 'promotion_failed 必须恢复');
    assert.strictEqual(recoveredPart.artifact.status, 'promotion_failed', 'status 不变');
    assert.strictEqual(recoveredPart.artifact.error, 'NETWORK_BOOM-06', 'error 保留');
    assert.strictEqual(recoveredPart.artifact.storyText, before.storyText);
    assert.strictEqual(recoveredPart.artifact.sourceMessageId, sourceId);
    assert.strictEqual(recoveredPart.artifact.prompt, before.prompt);
    assert.strictEqual(recoveredPart.artifact.voiceId, before.voiceId);
    assert.strictEqual(createCalls.length, 0, 'rehydrate 不 retry，create=0');
    assert.strictEqual(agentInteractCalls, 0);
    // 恢复后 M4-05 retry 仍可 dispatch（仅断言入口存在且为 promotion_failed 可重试态）。
    assert.strictEqual(recoveredPart.artifact.status, 'promotion_failed');
    console.log('PASS: M4-06-02 promotion_failed exact round-trip');
  }

  console.log('=== M4-06-03: Persisted promoting recovery ===');
  {
    resetAll();
    const serverId = 'assistant-promoting-03';
    stubFetchRows = [artifactDto(serverId, promotingArtifact(serverId))];
    await useChatStore.getState().initForUser();
    assert.strictEqual(fetchCount, 1, '必须拉取一次服务端快照');
    const { artifact } = getArtifact(serverId);
    assert.strictEqual(artifact.status, 'promotion_failed', '历史 promoting 必须恢复为 promotion_failed');
    assert.strictEqual(artifact.storyText, '完整正文-06', '正文保留');
    assert.strictEqual(artifact.sourceMessageId, serverId);
    assert.strictEqual(createCalls.length, 0, 'library.create=0');
    assert.strictEqual(pendingCreates.length, 0, 'promotion kick=0');
    assert.strictEqual(agentInteractCalls, 0, 'generation=0');
    assert.strictEqual(fetchCount, 1, '恢复本身不触发二次 fetch/save-back');
    assert.strictEqual(saveCalls.length, 0, 'initForUser 不 save-back');
    console.log('PASS: M4-06-03 persisted promoting recovery');
  }

  console.log('=== M4-06-04: Persisted complete recovery ===');
  {
    resetAll();
    const serverId = 'assistant-complete-04';
    stubFetchRows = [artifactDto(serverId, completeArtifact(serverId))];
    await useChatStore.getState().initForUser();
    const { artifact } = getArtifact(serverId);
    assert.strictEqual(artifact.status, 'promotion_failed', '历史 complete 必须恢复为 promotion_failed');
    assert.strictEqual(artifact.storyText, '完整正文-06', '正文与 frozen 快照不变');
    assert.strictEqual(artifact.sourceMessageId, serverId);
    assert.strictEqual(artifact.prompt, 'prompt-快照-06');
    assert.strictEqual(artifact.voiceId, 'voice-06');
    assert.strictEqual(artifact.title, '标题-06');
    assert.strictEqual(createCalls.length, 0, '不能自动 create');
    assert.strictEqual(agentInteractCalls, 0);
    assert.strictEqual(saveCalls.length, 0, '不 save-back');
    console.log('PASS: M4-06-04 persisted complete recovery');
  }

  console.log('=== M4-06-05: Persisted draft recovery ===');
  {
    resetAll();
    const serverId = 'assistant-draft-05';
    stubFetchRows = [artifactDto(serverId, draftArtifact(serverId))];
    await useChatStore.getState().initForUser();
    const { msg, artifact } = getArtifact(serverId);
    assert.strictEqual(artifact.status, 'interrupted', '历史 draft 必须恢复为 interrupted');
    assert.strictEqual(artifact.storyText, '部分正文-草稿', '部分正文保留');
    assert.strictEqual(
      artifact.reason,
      historyModule.HISTORY_RELOAD_INTERRUPTED_REASON,
      'reason 必须为 deterministic 内部值',
    );
    assert.notStrictEqual(msg.status, 'sending', '不得把 message 再置 sending');
    assert.strictEqual(createCalls.length, 0);
    assert.strictEqual(agentInteractCalls, 0, '不得启动 generation');
    console.log('PASS: M4-06-05 persisted draft recovery');
  }

  console.log('=== M4-06-06: Stable interrupted compatibility ===');
  {
    resetAll();
    const serverId = 'assistant-interrupted-06';
    // 注意：本条只测 decoder 可读性，不改变 failed-message save filtering（toSnapshot 仍只存 delivered）。
    stubFetchRows = [artifactDto(serverId, interruptedArtifact(serverId))];
    await useChatStore.getState().initForUser();
    const { artifact } = getArtifact(serverId);
    assert.strictEqual(artifact.status, 'interrupted');
    assert.strictEqual(artifact.storyText, '部分正文-中断');
    assert.strictEqual(artifact.reason, 'aborted');
    assert.strictEqual(artifact.id, `artifact-${serverId}`);
    assert.strictEqual(artifact.sourceMessageId, serverId);
    console.log('PASS: M4-06-06 stable interrupted compatibility');
  }

  console.log('=== M4-06-07: Save-side canonicalization + immutability (blocking) ===');
  {
    resetAll();
    const draftId = 'assistant-live-draft-07';
    const completeId = 'assistant-live-complete-07';
    const promotingId = 'assistant-live-promoting-07';
    const liveDraft = draftArtifact(draftId, { storyText: 'live-draft-部分' });
    const liveComplete = completeArtifact(completeId, { storyText: 'live-complete-全文' });
    const livePromoting = promotingArtifact(promotingId, { storyText: 'live-promoting-全文' });
    const beforeDraftJson = JSON.stringify(liveDraft);
    const beforeCompleteJson = JSON.stringify(liveComplete);
    const beforePromotingJson = JSON.stringify(livePromoting);
    useChatStore.setState({
      syncEnabled: true,
      messages: [
        { id: 'user-07', role: 'user', content: 'hi', status: 'delivered', createdAt: NOW },
        {
          id: draftId,
          role: 'assistant',
          content: 'live-draft-部分',
          status: 'delivered',
          createdAt: NOW,
          parts: [{ type: 'storyArtifact', artifact: liveDraft }],
        },
        {
          id: completeId,
          role: 'assistant',
          content: 'live-complete-全文',
          status: 'delivered',
          createdAt: NOW,
          parts: [{ type: 'storyArtifact', artifact: liveComplete }],
        },
        {
          id: promotingId,
          role: 'assistant',
          content: 'live-promoting-全文',
          status: 'delivered',
          createdAt: NOW,
          parts: [{ type: 'storyArtifact', artifact: livePromoting }],
        },
      ] as ChatMsg[],
    });
    saveCalls = [];
    const flushed = await useChatStore.getState().flushPendingSave();
    assert.strictEqual(flushed, true, 'flush 应成功并捕获 payload');
    assert.strictEqual(saveCalls.length, 1, '应恰好一次 saveMyConversation');
    const payload = saveCalls[0].messages;
    const findPayloadArtifact = (messageId: string): ArtifactView => {
      const row = payload.find((m) => m.messageId === messageId);
      assert.ok(row, `payload 必须含 ${messageId}`);
      const part = (row.parts ?? []).find((p) => p.type === 'storyArtifact') as unknown as {
        artifact: ArtifactView;
      } | undefined;
      assert.ok(part, `payload ${messageId} 必须含 storyArtifact`);
      return part.artifact;
    };
    assert.strictEqual(findPayloadArtifact(draftId).status, 'interrupted', '落盘 draft→interrupted');
    assert.strictEqual(findPayloadArtifact(completeId).status, 'promotion_failed', '落盘 complete→promotion_failed');
    assert.strictEqual(findPayloadArtifact(promotingId).status, 'promotion_failed', '落盘 promoting→promotion_failed');
    // 落盘 payload 不得 mutate live store（blocking）。
    const liveDraftAfter = getArtifact(draftId).artifact;
    const liveCompleteAfter = getArtifact(completeId).artifact;
    const livePromotingAfter = getArtifact(promotingId).artifact;
    assert.strictEqual(liveDraftAfter.status, 'draft', '内存仍 draft');
    assert.strictEqual(liveCompleteAfter.status, 'complete', '内存仍 complete');
    assert.strictEqual(livePromotingAfter.status, 'promoting', '内存仍 promoting');
    assert.strictEqual(JSON.stringify(liveDraft), beforeDraftJson, 'serializer 不得 mutate 输入 draft');
    assert.strictEqual(JSON.stringify(liveComplete), beforeCompleteJson, 'serializer 不得 mutate 输入 complete');
    assert.strictEqual(JSON.stringify(livePromoting), beforePromotingJson, 'serializer 不得 mutate 输入 promoting');
    // Deterministic：同一对象连续 serialize 两次等价。
    const once = historyModule.serializePartsForHistory([
      { type: 'storyArtifact', artifact: JSON.parse(JSON.stringify(liveDraft)) },
    ] as unknown as Parameters<typeof historyModule.serializePartsForHistory>[0]);
    const twice = historyModule.serializePartsForHistory(once);
    assert.deepStrictEqual(twice, once, 'serialize 必须 deterministic 且幂等');
    console.log('PASS: M4-06-07 save-side canonicalization + immutability');
  }

  console.log('=== M4-06-08: Await-window live attempt isolation ===');
  {
    resetAll();
    const serverDraftId = 'assistant-server-draft-08';
    const serverPromotingId = 'assistant-server-promoting-08';
    const serverRows: DtoLike[] = [
      artifactDto(serverDraftId, draftArtifact(serverDraftId, { storyText: 'server-旧草稿' })),
      artifactDto(serverPromotingId, promotingArtifact(serverPromotingId, { storyText: 'server-旧 promoting' })),
    ];
    let resolveFetch: ((rows: DtoLike[]) => void) | null = null;
    fetchImpl = () =>
      new Promise<DtoLike[]>((resolve) => {
        resolveFetch = resolve;
      });
    const initPromise = useChatStore.getState().initForUser();
    await flush();
    // fetch pending 窗口内本地真实 attempt：submit → intent → delta → story_complete（进入 promoting 在途）。
    useChatStore.getState().dispatch({ type: 'user.submit', content: '本地新故事-08' } as DispatchArg);
    const localAssistantId = useChatStore.getState().selectors.latestAssistantMessage()?.id;
    assert.ok(localAssistantId, '本地 assistant 占位必须存在');
    const localId = localAssistantId as string;
    useChatStore.getState().dispatch({ type: 'stream.intent', intent: 'Story', messageId: localId } as DispatchArg);
    useChatStore.getState().dispatch({ type: 'stream.delta', content: '本地草稿', messageId: localId } as DispatchArg);
    useChatStore.getState().dispatch({
      type: 'stream.story_complete',
      messageId: localId,
      storyText: '本地完整正文-08',
    } as DispatchArg);
    assert.strictEqual(getArtifact(localId).artifact.status, 'promoting', '本地应为真实在途 promoting');
    assert.strictEqual(createCalls.length, 1, '本地 promoting 应恰好 kick 一次');
    assert.strictEqual(pendingCreates.length, 1);
    // server fetch resolve（历史 transient）。
    assert.ok(resolveFetch, 'fetch 必须处于 pending');
    (resolveFetch as (rows: DtoLike[]) => void)(serverRows.map((r) => JSON.parse(JSON.stringify(r)) as DtoLike));
    await initPromise;
    await flush();
    // server 历史被 recovery。
    assert.strictEqual(getArtifact(serverDraftId).artifact.status, 'interrupted', 'server draft 被 recovery');
    assert.strictEqual(
      getArtifact(serverPromotingId).artifact.status,
      'promotion_failed',
      'server promoting 被 recovery',
    );
    // 本地 await-window 消息 untouched。
    const localAfter = getArtifact(localId);
    assert.strictEqual(localAfter.artifact.status, 'promoting', '本地 live promoting 绝不能被 normalize');
    assert.strictEqual(localAfter.artifact.sourceMessageId, localId, '本地 sourceMessageId 不变');
    assert.strictEqual(localAfter.artifact.storyText, '本地完整正文-08');
    assert.strictEqual(createCalls.length, 1, 'History loader 不得新增 promotion kick');
    // 本地在途 promotion 随后 resolve 仍可正常 ready。
    pendingCreates[0].resolve(makeDto(806, pendingCreates[0].input));
    await flush();
    const localReady = getArtifact(localId);
    assert.strictEqual(localReady.artifact.status, 'ready', '本地在途 resolve 仍可 ready');
    assert.strictEqual(localReady.artifact.storyWorkId, 806);
    assert.strictEqual(localReady.artifact.sourceMessageId, localId);
    fetchImpl = null;
    console.log('PASS: M4-06-08 await-window isolation');
  }

  console.log('=== M4-06-09: Malformed Artifact fail-closed ===');
  {
    resetAll();
    const goodId = 'assistant-good-09';
    const unknownId = 'assistant-unknown-09';
    const noWorkId = 'assistant-ready-noid-09';
    const badWorkId = 'assistant-ready-badid-09';
    const nonReadyWithId = 'assistant-draft-withid-09';
    const emptyStruct = 'assistant-empty-09';
    stubFetchRows = [
      artifactDto(goodId, readyArtifact(goodId)),
      {
        messageId: unknownId,
        role: 'assistant',
        content: 'ORIG-unknown',
        parts: [
          {
            type: 'storyArtifact',
            artifact: {
              id: `artifact-${unknownId}`,
              artifactType: 'story',
              status: 'super_future_status',
              sourceMessageId: unknownId,
              storyText: 'x',
              createdAt: NOW,
              updatedAt: NOW,
            },
          },
        ],
        createdAt: NOW,
      },
      {
        messageId: noWorkId,
        role: 'assistant',
        content: 'ORIG-no-workid',
        parts: [
          {
            type: 'storyArtifact',
            artifact: {
              id: `artifact-${noWorkId}`,
              artifactType: 'story',
              status: 'ready',
              sourceMessageId: noWorkId,
              storyText: '正文',
              createdAt: NOW,
              updatedAt: NOW,
            },
          },
        ],
        createdAt: NOW,
      },
      {
        messageId: badWorkId,
        role: 'assistant',
        content: 'ORIG-bad-workid',
        parts: [
          { type: 'storyArtifact', artifact: readyArtifact(badWorkId, { storyWorkId: 0 }) },
        ],
        createdAt: NOW,
      },
      {
        messageId: nonReadyWithId,
        role: 'assistant',
        content: 'ORIG-draft-withid',
        parts: [
          {
            type: 'storyArtifact',
            artifact: { ...draftArtifact(nonReadyWithId), storyWorkId: 999 },
          },
        ],
        createdAt: NOW,
      },
      {
        messageId: emptyStruct,
        role: 'assistant',
        content: 'ORIG-empty',
        parts: [{ type: 'storyArtifact', artifact: { nonsense: true } }],
        createdAt: NOW,
      },
    ];
    await useChatStore.getState().initForUser();
    // 合法对照仍完整保留。
    assert.strictEqual(getArtifact(goodId).artifact.status, 'ready');
    // 非法一律丢 part、保 content、不 crash、不 create、不 generation。
    for (const [id, orig] of [
      [unknownId, 'ORIG-unknown'],
      [noWorkId, 'ORIG-no-workid'],
      [badWorkId, 'ORIG-bad-workid'],
      [nonReadyWithId, 'ORIG-draft-withid'],
      [emptyStruct, 'ORIG-empty'],
    ] as Array<[string, string]>) {
      const msg = getMessage(id);
      assert.ok(msg, `坏 Artifact 消息不得被删除整条: ${id}`);
      assert.strictEqual(msg.content, orig, `${id} 原 content 仍保留`);
      const types = getPartTypes(id);
      assert.ok(!types.includes('storyArtifact'), `${id} 非法 storyArtifact part 必须被拒`);
      assert.strictEqual(msg.parts, undefined, `${id} 无合法 parts 时应为 undefined（走 content fallback）`);
    }
    assert.strictEqual(createCalls.length, 0, '无 create');
    assert.strictEqual(agentInteractCalls, 0, '无 generation');
    assert.strictEqual(saveCalls.length, 0, '不 save-back');
    console.log('PASS: M4-06-09 malformed fail-closed');
  }

  console.log('=== M4-06-10: Source ownership corruption ===');
  {
    resetAll();
    const badMsgId = 'assistant-B-10';
    const goodMsgId = 'assistant-good-10';
    stubFetchRows = [
      {
        messageId: badMsgId,
        role: 'assistant',
        content: 'ORIG-content-B',
        parts: [{ type: 'storyArtifact', artifact: readyArtifact('assistant-A-10') }],
        createdAt: NOW,
      },
      artifactDto(goodMsgId, readyArtifact(goodMsgId)),
    ];
    await useChatStore.getState().initForUser();
    const badMsg = getMessage(badMsgId);
    assert.ok(badMsg, '坏归属消息不得被删除整条');
    assert.strictEqual(badMsg.content, 'ORIG-content-B', '原 content 仍保留');
    assert.ok(!getPartTypes(badMsgId).includes('storyArtifact'), 'ownership 非法 part 必须 fail-closed');
    assert.strictEqual(badMsg.parts, undefined);
    assert.strictEqual(badMsg.id, badMsgId, '不把 message id 改 A');
    // 合法对照：message.id === sourceMessageId 完整保留。
    const good = getArtifact(goodMsgId);
    assert.strictEqual(good.artifact.status, 'ready');
    assert.strictEqual(good.artifact.sourceMessageId, goodMsgId);
    assert.strictEqual(good.artifact.storyWorkId, 123);
    assert.strictEqual(createCalls.length, 0, '不 promotion');
    assert.strictEqual(agentInteractCalls, 0);
    console.log('PASS: M4-06-10 source ownership corruption');
  }

  console.log('=== M4-06-11: Legacy + non-Artifact compatibility ===');
  {
    resetAll();
    const legacyId = 'assistant-legacy-11';
    const mixedId = 'assistant-mixed-11';
    stubFetchRows = [
      {
        messageId: legacyId,
        role: 'assistant',
        content: 'legacy-content',
        parts: [{ type: 'storyCard', storyText: 'legacy-正文', audioUrl: 'https://audio/legacy.mp3' }],
        createdAt: NOW,
      },
      {
        messageId: mixedId,
        role: 'assistant',
        content: 'mixed-content',
        parts: [
          { type: 'text', content: 'hello' },
          { type: 'guidance', content: 'guide-正文' },
          { type: 'summary', content: 'summary-正文' },
        ],
        createdAt: NOW,
      },
    ];
    await useChatStore.getState().initForUser();
    assert.deepStrictEqual(getPartTypes(legacyId), ['storyCard'], 'storyCard→storyCard，不得转写');
    const legacyMsg = getMessage(legacyId) as ChatMsg;
    const legacyPart = (legacyMsg.parts?.[0] ?? {}) as { type: string; storyText?: string; audioUrl?: string };
    assert.strictEqual(legacyPart.storyText, 'legacy-正文');
    assert.deepStrictEqual(getPartTypes(mixedId), ['text', 'guidance', 'summary'], 'text/guidance/summary 不得误删/转换');
    assert.strictEqual(createCalls.length, 0, 'History loader 不得 create StoryWork');
    assert.strictEqual(agentInteractCalls, 0);
    // 保存侧既有 audioUrl 清空行为仍成立。
    const serializedLegacy = historyModule.serializePartsForHistory([
      { type: 'storyCard', storyText: 'legacy-正文', audioUrl: 'https://audio/legacy.mp3' },
    ] as unknown as Parameters<typeof historyModule.serializePartsForHistory>[0]);
    assert.ok(serializedLegacy && serializedLegacy.length === 1);
    assert.strictEqual(
      (serializedLegacy[0] as { audioUrl?: string }).audioUrl,
      '',
      '保存侧 storyCard audioUrl 清空保持',
    );
    assert.strictEqual((serializedLegacy[0] as { type: string }).type, 'storyCard', '不得转 storyArtifact');
    console.log('PASS: M4-06-11 legacy compatibility');
  }

  console.log('=== M4-06-12: Architecture + content-invariant guards ===');
  {
    const codecPath = path.resolve(process.cwd(), 'lib/client/chatArtifactHistory.ts');
    const codecContent = fs.readFileSync(codecPath, 'utf8');
    for (const forbidden of [
      'libraryClient',
      'storyArtifactPromotion',
      'chatPromotionOrchestration',
      'executePromotionCreate',
      'library.create',
      'interactWithAgent',
      'agentFlow',
      'chatFlow',
      'playbackStore',
      'usePlaybackStore',
      'playbackProgress',
      'playStoryText',
      'from \'react\'',
      'from "react"',
      'zustand',
      'useChatStore',
      'lib/server',
      'lib/db',
      'prisma',
      '@prisma',
      'useConfigStore',
      'configStore',
      'settingStore',
      'promotionToken',
      'promotionEpoch',
      'inflightPromotions',
      'fetchMyConversation',
      'saveMyConversation',
    ]) {
      assert.strictEqual(
        codecContent.includes(forbidden),
        false,
        `History codec 不得出现 ${forbidden}`,
      );
    }
    assert.ok(codecContent.includes('canonicalizeArtifactForHistory'), 'codec 必须暴露 canonicalize');
    assert.ok(codecContent.includes('rehydrateStoryArtifactPart'), 'codec 必须暴露 rehydrate');
    // initForUser 恢复路径行为守卫：纯 restore，不 save-back、不自动 retry。
    resetAll();
    const serverId = 'assistant-arch-12';
    stubFetchRows = [artifactDto(serverId, promotingArtifact(serverId))];
    const storePath = path.resolve(process.cwd(), 'stores/chatStore.ts');
    const storeContent = fs.readFileSync(storePath, 'utf8');
    const initIndex = storeContent.lastIndexOf('initForUser: () => {');
    assert.ok(initIndex !== -1, 'chatStore 必须保留 initForUser');
    const resetIndex = storeContent.indexOf('reset: () =>', initIndex);
    const initBlock = storeContent.slice(initIndex, resetIndex === -1 ? initIndex + 4000 : resetIndex);
    assert.strictEqual(initBlock.includes('promotion.retry'), false, 'initForUser 恢复路径不得 promotion.retry');
    assert.strictEqual(initBlock.includes('executePromotionCreate'), false, 'initForUser 不得 executePromotionCreate');
    assert.strictEqual(initBlock.includes('user.retry'), false, 'initForUser 不得 user.retry');
    assert.ok(initBlock.includes('rehydrateServerMessages'), 'initForUser 必须经 History codec 恢复');
    assert.ok(initBlock.includes('mergeConversation'), 'initForUser 必须保留 await-window 合并');
    await useChatStore.getState().initForUser();
    assert.strictEqual(getArtifact(serverId).artifact.status, 'promotion_failed');
    assert.strictEqual(createCalls.length, 0, '恢复路径 library.create=0');
    assert.strictEqual(saveCalls.length, 0, '恢复路径 save-back=0');
    // content invariant：dto.content=OLD + artifact.storyText=NEW → valid Artifact wins。
    const winDto: DtoLike = artifactDto('assistant-win-12', readyArtifact('assistant-win-12'), 'OLD');
    const winMsg = historyModule.rehydrateMessageFromHistory(winDto);
    assert.strictEqual(winMsg.content, '完整正文-06', 'valid Artifact wins');
    console.log('PASS: M4-06-12 architecture guards');
  }

  console.log('\nALL ARTIFACT HISTORY TESTS PASSED SUCCESSFULLY');
}

const testPromise = main()
  .then(() => {
    console.log('ALL ARTIFACT HISTORY TESTS PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('TEST FAILED:', err);
    process.exit(1);
  })
  .finally(() => {
    setPromotionCreateOverride(undefined);
    try {
      useChatStore.getState().reset();
    } catch {
      // 忽略清理失败。
    }
  });

export default testPromise;
