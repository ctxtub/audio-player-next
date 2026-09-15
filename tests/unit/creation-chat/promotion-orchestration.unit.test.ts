import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type {
  LibraryCreateInput,
  StoryWorkDetailDTO,
} from '../../../lib/trpc/schemas/library';

// 中文注释：M4-04 编排回归——complete → startPromotion() → promoteStoryArtifact() → ready / promotion_failed
// 真正接进 Chat orchestration，锁定 stale / interrupt / failure / retry 语义（E2E-08-04）。
// 全程内存打桩（promotion create 可控 deferred 桩），不建 socket、不绑端口，不碰 prisma/dev.db。

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
    summarizeContext: async () => '探针摘要-M404',
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

type DispatchArg = Parameters<ReturnType<typeof useChatStore.getState>['dispatch']>[0];
type ChatMsg = ReturnType<typeof useChatStore.getState>['messages'][number];
interface ArtifactView {
  status: string;
  sourceMessageId: string;
  storyText: string;
  storyWorkId?: unknown;
  prompt?: unknown;
  voiceId?: unknown;
  error?: unknown;
}

// 中文注释：可控 deferred create 桩——kick 同步记录，结算由测试显式 resolve/reject。
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

function submitStory(
  content = '讲个小狐狸故事',
  snapshots?: { promptSnapshot?: string; voiceSnapshot?: string },
): string {
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

async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await Promise.resolve();
  await Promise.resolve();
}

/** 完整走完 submit→intent→delta→story_complete，返回 assistantId（promotion 在途未结算）。 */
function completeAndPromote(
  text: string,
  snapshots?: { promptSnapshot?: string; voiceSnapshot?: string },
): string {
  const assistantId = submitStory(text, snapshots);
  intentStory(assistantId);
  delta(assistantId, '草稿');
  storyComplete(assistantId, text);
  return assistantId;
}

function conflictError(): Error & { code?: string } {
  const err = new Error('CONFLICT: same sourceMessageId with different contentHash') as Error & {
    code?: string;
  };
  err.code = 'CONFLICT';
  return err;
}

async function main(): Promise<void> {
  console.log('=== M4-04-01: story_complete → exactly one library.create → ready(storyWorkId) ===');
  {
    resetBaseline();
    const assistantId = completeAndPromote('完整正文-01', {
      promptSnapshot: '写个小狐狸故事',
      voiceSnapshot: 'voice-frozen-01',
    });
    const promoting = getArtifact(assistantId);
    assert.strictEqual(promoting.artifact.status, 'promoting', 'story_complete 必须同步进入 promoting');
    assert.strictEqual(createCalls.length, 1, '必须恰好 kick 一次 library.create');
    assert.deepStrictEqual(
      createCalls[0],
      {
        title: undefined,
        prompt: '写个小狐狸故事',
        storyText: '完整正文-01',
        voiceId: 'voice-frozen-01',
        sourceMessageId: assistantId,
      },
      '必须透传冻结五字段（prompt/voice 取生成开始快照）',
    );
    assert.strictEqual(pendingCreates.length, 1);
    pendingCreates[0].resolve(makeDto(777, pendingCreates[0].input));
    await flush();
    const ready = getArtifact(assistantId);
    assert.strictEqual(ready.artifact.status, 'ready');
    assert.strictEqual(ready.artifact.storyWorkId, 777);
    assert.strictEqual(ready.artifact.sourceMessageId, assistantId, 'sourceMessageId 全程不变');
    assert.strictEqual(ready.artifact.storyText, '完整正文-01');
    console.log('PASS: M4-04-01 success orchestration');
  }

  console.log('=== M4-04-02: duplicate story_complete / done 不产生第二次 promotion ===');
  {
    resetBaseline();
    const assistantId = completeAndPromote('完整正文-02');
    assert.strictEqual(createCalls.length, 1);
    storyComplete(assistantId, '完整正文-02');
    storyComplete(assistantId, '完整正文-02');
    finish(assistantId);
    assert.strictEqual(createCalls.length, 1, '重复 complete 与 done 不得产生第二次 promotion');
    const still = getArtifact(assistantId);
    assert.strictEqual(still.artifact.status, 'promoting');
    assert.strictEqual(still.msg.status, 'delivered');
    pendingCreates[0].resolve(makeDto(778, pendingCreates[0].input));
    await flush();
    const ready = getArtifact(assistantId);
    assert.strictEqual(ready.artifact.status, 'ready');
    assert.strictEqual(ready.artifact.storyWorkId, 778);
    assert.strictEqual(createCalls.length, 1);
    console.log('PASS: M4-04-02 duplicate no second promotion');
  }

  console.log('=== M4-04-03: promotion reject → promotion_failed，完整正文/快照不丢 ===');
  {
    resetBaseline();
    const assistantId = completeAndPromote('完整正文-03', {
      promptSnapshot: '失败保留 prompt-03',
      voiceSnapshot: 'voice-frozen-03',
    });
    assert.strictEqual(createCalls.length, 1);
    pendingCreates[0].reject(new Error('NETWORK_BOOM-03'));
    await flush();
    const failed = getArtifact(assistantId);
    assert.strictEqual(failed.artifact.status, 'promotion_failed');
    assert.strictEqual(failed.artifact.storyText, '完整正文-03', 'storyText 必须完整保留');
    assert.strictEqual(failed.artifact.sourceMessageId, assistantId, 'sourceMessageId 必须保留');
    assert.strictEqual(failed.artifact.prompt, '失败保留 prompt-03', 'prompt 快照必须保留');
    assert.strictEqual(failed.artifact.voiceId, 'voice-frozen-03', 'voice 快照必须保留');
    assert.strictEqual(failed.artifact.storyWorkId, undefined);
    assert.ok(String(failed.artifact.error ?? '').includes('NETWORK_BOOM-03'), 'error 必须记录');
    assert.notStrictEqual(failed.msg.status, 'failed', 'delivery 不得整体置 failed');
    assert.strictEqual(useChatStore.getState().messages.length, 2, '不得重生成/增殖消息');
    console.log('PASS: M4-04-03 failure preserves snapshots');
  }

  console.log('=== M4-04-04: retry promotion → 只再次 library.create，不碰 generation ===');
  {
    resetBaseline();
    const assistantId = completeAndPromote('完整正文-04', {
      promptSnapshot: '重试 prompt-04',
      voiceSnapshot: 'voice-frozen-04',
    });
    pendingCreates[0].reject(new Error('TIMEOUT-04'));
    await flush();
    assert.strictEqual(getArtifact(assistantId).artifact.status, 'promotion_failed');
    const messagesBefore = useChatStore.getState().messages.length;
    promotionRetry(assistantId);
    const retrying = getArtifact(assistantId);
    assert.strictEqual(retrying.artifact.status, 'promoting', '重试必须回到 promoting');
    assert.strictEqual(createCalls.length, 2, '重试必须只再发一次 library.create');
    assert.deepStrictEqual(createCalls[1], createCalls[0], '重试 input 必须与首次完全一致（同源同文）');
    assert.strictEqual(
      useChatStore.getState().messages.length,
      messagesBefore,
      '重试不得新建 assistant 消息/重走生成',
    );
    assert.strictEqual(
      useChatStore.getState().selectors.latestAssistantMessage()?.id,
      assistantId,
      '重试不得更换 attempt 身份',
    );
    // 静态：编排层绝不触达 generation transport。
    const orchContent = fs.readFileSync(
      path.resolve(process.cwd(), 'lib/client/chatPromotionOrchestration.ts'),
      'utf8',
    );
    assert.strictEqual(orchContent.includes('interactWithAgent'), false, '编排不得触达 generation transport');
    assert.strictEqual(orchContent.includes('agentFlow'), false);
    assert.strictEqual(orchContent.includes('chatFlow'), false);
    console.log('PASS: M4-04-04 retry only re-creates');
  }

  console.log('=== M4-04-05: retry success → ready，sourceMessageId 不变 ===');
  {
    // 承接 04 的在途重试（同一基线内连续推进，避免跨段干扰）。
    const assistantId = useChatStore.getState().selectors.latestAssistantMessage()?.id as string;
    assert.strictEqual(getArtifact(assistantId).artifact.status, 'promoting');
    pendingCreates[1].resolve(makeDto(779, pendingCreates[1].input));
    await flush();
    const ready = getArtifact(assistantId);
    assert.strictEqual(ready.artifact.status, 'ready');
    assert.strictEqual(ready.artifact.storyWorkId, 779);
    assert.strictEqual(ready.artifact.sourceMessageId, assistantId, '重试成功不得更换 sourceMessageId');
    assert.strictEqual(ready.artifact.storyText, '完整正文-04');
    console.log('PASS: M4-04-05 retry success keeps source');
  }

  console.log('=== M4-04-06: stream abort/fail before complete → create = 0 ===');
  {
    resetBaseline();
    const abortId = submitStory('中断前用例-abort');
    intentStory(abortId);
    delta(abortId, '未完成草稿');
    useChatStore.getState().dispatch({ type: 'stream.abort', messageId: abortId, reason: 'aborted' } as DispatchArg);
    assert.strictEqual(getArtifact(abortId).artifact.status, 'interrupted');
    assert.strictEqual(createCalls.length, 0, 'abort before complete 不得 kick promotion');

    const failId = submitStory('中断前用例-fail');
    intentStory(failId);
    delta(failId, '未完成草稿-fail');
    useChatStore.getState().dispatch({ type: 'stream.fail', error: 'net', messageId: failId } as DispatchArg);
    assert.strictEqual(getArtifact(failId).artifact.status, 'interrupted');
    assert.strictEqual(createCalls.length, 0, 'fail before complete 不得 kick promotion');

    // 中断后迟到的 story_complete 不得复活为 promoting，更不得 kick。
    storyComplete(abortId, '迟到正文-不得覆盖');
    assert.strictEqual(getArtifact(abortId).artifact.status, 'interrupted');
    assert.strictEqual(createCalls.length, 0);
    console.log('PASS: M4-04-06 interrupt before complete zero create');
  }

  console.log('=== M4-04-07: A promotion pending → generation retry B → A 晚到结果不污染 B ===');
  {
    // 07-1 resolve 变体：A promoting 在途 → fail(A) 仅改 delivery → user.retry 建 B（A 被移除）→ A resolve 必须 no-op。
    resetBaseline();
    const idA = completeAndPromote('A-完整正文-07');
    assert.strictEqual(createCalls.length, 1);
    useChatStore.getState().dispatch({ type: 'stream.fail', error: 'late-transport', messageId: idA } as DispatchArg);
    assert.strictEqual(getArtifact(idA).artifact.status, 'promoting', 'fail 不得把 promoting 倒退为 interrupted');
    useChatStore.getState().dispatch({ type: 'user.retry' } as DispatchArg);
    const idB = useChatStore.getState().selectors.latestAssistantMessage()?.id as string;
    assert.ok(idB && idB !== idA, 'generation retry 必须建立新 Attempt B');
    assert.strictEqual(getMessage(idA), undefined, '被替换的 A 不得复活');
    assert.strictEqual(getArtifact(idB).artifact.status, 'draft');
    pendingCreates[0].resolve(makeDto(701, pendingCreates[0].input));
    await flush();
    assert.strictEqual(getMessage(idA), undefined, 'A success 不得复活 A');
    const artifactB = getArtifact(idB);
    assert.strictEqual(artifactB.artifact.status, 'draft', 'A success 不得把 B 改 ready');
    assert.strictEqual(artifactB.artifact.storyWorkId, undefined, 'StoryWork A 不得绑到 B');
    assert.strictEqual(artifactB.artifact.sourceMessageId, idB);

    // 07-2 reject 变体：C promoting 在途 → retry 建 D → C reject 必须 no-op。
    resetBaseline();
    const idC = completeAndPromote('C-完整正文-07');
    useChatStore.getState().dispatch({ type: 'stream.fail', error: 'late-transport', messageId: idC } as DispatchArg);
    useChatStore.getState().dispatch({ type: 'user.retry' } as DispatchArg);
    const idD = useChatStore.getState().selectors.latestAssistantMessage()?.id as string;
    assert.ok(idD && idD !== idC);
    pendingCreates[0].reject(new Error('STALE-REJECT-07'));
    await flush();
    assert.strictEqual(getMessage(idC), undefined, 'C reject 不得复活 C');
    assert.strictEqual(getArtifact(idD).artifact.status, 'draft', 'C reject 不得污染 D');
    console.log('PASS: M4-04-07 stale promotion no pollution');
  }

  console.log('=== M4-04-08: reset/clear 后旧 promotion resolve/reject 一律 no-op ===');
  {
    // 08-1 resetChat 后 resolve。
    resetBaseline();
    const idA = completeAndPromote('旧正文-08A');
    assert.strictEqual(createCalls.length, 1);
    useChatStore.getState().resetChat();
    assert.strictEqual(useChatStore.getState().messages.length, 0);
    pendingCreates[0].resolve(makeDto(801, pendingCreates[0].input));
    await flush();
    assert.strictEqual(useChatStore.getState().messages.length, 0, 'resetChat 后旧 resolve 必须 no-op');

    // 08-2 resetChat 后 reject。
    resetBaseline();
    const idB = completeAndPromote('旧正文-08B');
    void idB;
    useChatStore.getState().resetChat();
    pendingCreates[0].reject(new Error('STALE-AFTER-CLEAR-08'));
    await flush();
    assert.strictEqual(useChatStore.getState().messages.length, 0, 'resetChat 后旧 reject 必须 no-op');

    // 08-3 reset（登出清本地）后 resolve。
    resetBaseline();
    completeAndPromote('旧正文-08C');
    useChatStore.getState().reset();
    useChatStore.setState({ syncEnabled: false });
    pendingCreates[0].resolve(makeDto(803, pendingCreates[0].input));
    await flush();
    assert.strictEqual(useChatStore.getState().messages.length, 0, 'reset 后旧 resolve 必须 no-op');
    console.log('PASS: M4-04-08 reset no-op');
  }

  console.log('=== M4-04-09: 两次快速 promotion.retry 最多一个 in-flight create ===');
  {
    resetBaseline();
    const assistantId = completeAndPromote('完整正文-09');
    pendingCreates[0].reject(new Error('FLAKY-09'));
    await flush();
    assert.strictEqual(getArtifact(assistantId).artifact.status, 'promotion_failed');
    assert.strictEqual(createCalls.length, 1);
    // 同 tick 双击重试。
    promotionRetry(assistantId);
    promotionRetry(assistantId);
    assert.strictEqual(createCalls.length, 2, '快速双击最多只允许多一次 in-flight create');
    assert.strictEqual(getArtifact(assistantId).artifact.status, 'promoting');
    pendingCreates[1].resolve(makeDto(809, pendingCreates[1].input));
    await flush();
    const ready = getArtifact(assistantId);
    assert.strictEqual(ready.artifact.status, 'ready');
    assert.strictEqual(ready.artifact.storyWorkId, 809);
    // 终态 ready 上的重试一律忽略。
    promotionRetry(assistantId);
    assert.strictEqual(createCalls.length, 2, 'ready 终态重试必须忽略');
    console.log('PASS: M4-04-09 retry in-flight dedup');
  }

  console.log('=== M4-04-10: CONFLICT 不换源不重生成，保持明确 failure ===');
  {
    resetBaseline();
    const assistantId = completeAndPromote('原文-10');
    const messagesBefore = useChatStore.getState().messages.length;
    pendingCreates[0].reject(conflictError());
    await flush();
    const failed = getArtifact(assistantId);
    assert.strictEqual(failed.artifact.status, 'promotion_failed');
    assert.ok(String(failed.artifact.error ?? '').includes('CONFLICT'), 'error 必须明确记录 CONFLICT');
    assert.strictEqual(failed.artifact.sourceMessageId, assistantId, '不得自动换 sourceMessageId');
    assert.strictEqual(failed.artifact.storyText, '原文-10', '不得重生成/改写正文');
    assert.strictEqual(createCalls.length, 1, '不得自动重试');
    assert.strictEqual(
      useChatStore.getState().messages.length,
      messagesBefore,
      '不得新增 attempt',
    );
    console.log('PASS: M4-04-10 conflict explicit failure');
  }

  console.log('=== M4-04-11: complete 后 stream 后续事件不倒退 promoting/ready ===');
  {
    resetBaseline();
    const assistantId = completeAndPromote('完整正文-11');
    finish(assistantId);
    assert.strictEqual(getArtifact(assistantId).artifact.status, 'promoting');
    useChatStore.getState().dispatch({ type: 'stream.fail', error: 'late-fail', messageId: assistantId } as DispatchArg);
    assert.strictEqual(
      getArtifact(assistantId).artifact.status,
      'promoting',
      'promotion 在途时 stream.fail 不得倒退为 interrupted',
    );
    assert.strictEqual(createCalls.length, 1, '在途 promotion 不得被取消/重发');
    pendingCreates[0].resolve(makeDto(811, pendingCreates[0].input));
    await flush();
    assert.strictEqual(getArtifact(assistantId).artifact.status, 'ready');
    finish(assistantId);
    useChatStore.getState().dispatch({ type: 'stream.fail', error: 'late-fail-2', messageId: assistantId } as DispatchArg);
    assert.strictEqual(getArtifact(assistantId).artifact.status, 'ready', 'ready 不得被后续 stream 事件倒退');
    console.log('PASS: M4-04-11 no regression after complete');
  }

  console.log('=== M4-04-12: 静态架构纯净度守卫（唯一通道 / 无直调 / 无生成耦合） ===');
  {
    const orchPath = path.resolve(process.cwd(), 'lib/client/chatPromotionOrchestration.ts');
    const orchContent = fs.readFileSync(orchPath, 'utf8');
    assert.ok(orchContent.includes('promoteStoryArtifact'), '编排必须经唯一 adapter 通道');
    assert.strictEqual(orchContent.includes('libraryClient'), false, '编排不得直调 libraryClient');
    assert.strictEqual(orchContent.includes('library.create'), false, '编排不得直调 library.create');
    assert.strictEqual(orchContent.includes('lib/server'), false, '编排不得 import server');
    assert.strictEqual(orchContent.includes('prisma'), false, '编排不得 import prisma');
    assert.strictEqual(orchContent.includes('promoteArtifact'), false, '不得新增 promoteArtifact procedure 消费');
    assert.strictEqual(orchContent.includes('promotionToken'), false, 'token 不得进入编排持久语义（归调用方瞬态守卫）');

    const storePath = path.resolve(process.cwd(), 'stores/chatStore.ts');
    const storeContent = fs.readFileSync(storePath, 'utf8');
    assert.ok(storeContent.includes('chatPromotionOrchestration'), 'store 经薄编排层触发 promotion');
    assert.strictEqual(storeContent.includes('library.create'), false, 'store 不得直调 library.create');
    assert.strictEqual(storeContent.includes('storyArtifactPromotion'), false, 'store 不得直引 adapter（经编排层）');
    assert.ok(storeContent.includes('promotionToken'), 'store 必须持有 transient promotionToken 归属守卫');
    assert.ok(storeContent.includes('promotionEpoch'), 'store 必须持有 epoch 作废守卫');
    assert.ok(storeContent.includes('inflightPromotions'), 'store 必须持有在途去重守卫');

    const flowPath = path.resolve(process.cwd(), 'app/services/chatFlow.ts');
    const flowContent = fs.readFileSync(flowPath, 'utf8');
    assert.strictEqual(flowContent.includes('library.create'), false, 'chatFlow 不得直调 library.create');
    assert.strictEqual(flowContent.includes('storyArtifactPromotion'), false, 'chatFlow 不得直引 adapter');
    console.log('PASS: M4-04-12 static purity guards');
  }

  console.log('\nALL PROMOTION ORCHESTRATION TESTS PASSED SUCCESSFULLY');
}

const testPromise = main()
  .then(() => {
    console.log('ALL PROMOTION ORCHESTRATION TESTS PASSED SUCCESSFULLY!');
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
