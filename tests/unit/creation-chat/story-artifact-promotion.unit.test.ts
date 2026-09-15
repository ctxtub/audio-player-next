import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  completeArtifact,
  createDraftArtifact,
  interruptArtifact,
  markPromotionFailed,
  markPromotionSuccess,
  startPromotion,
} from '../../../lib/client/chatArtifactState';
import {
  assertPromotableArtifact,
  buildPromotionInput,
  promoteStoryArtifact,
} from '../../../lib/client/storyArtifactPromotion';
import type {
  CompleteChatArtifact,
  PromotionFailedChatArtifact,
} from '../../../types/chatArtifact';
import type {
  LibraryCreateInput,
  StoryWorkDetailDTO,
} from '../../../lib/trpc/schemas/library';

// 中文注释：M4-03 唯一 promotion 通道回归——CompleteChatArtifact → Promotion Adapter → libraryClient.create → StoryWorkDetailDTO。
// 本步仍然不要自动触发 promotion；adapter 只负责 I/O；快照在生成开始时冻结，promotion 严禁重读 Settings。
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
    summarizeContext: async () => '探针摘要-M403',
  },
} as unknown as NodeModule;

const { useChatStore } = nodeRequire('../../../stores/chatStore') as {
  useChatStore: typeof import('../../../stores/chatStore').useChatStore;
};

type DispatchArg = Parameters<ReturnType<typeof useChatStore.getState>['dispatch']>[0];
type ChatMsg = ReturnType<typeof useChatStore.getState>['messages'][number];

function resetBaseline(): void {
  useChatStore.getState().reset();
  useChatStore.setState({ syncEnabled: false });
}

function makeCompleteFixture(overrides?: {
  sourceMessageId?: string;
  storyText?: string;
  prompt?: string;
  voiceId?: string;
  title?: string;
}): CompleteChatArtifact {
  const draft = createDraftArtifact({
    sourceMessageId: overrides?.sourceMessageId ?? 'msg-promote-001',
    initialText: '草稿占位',
    prompt: overrides?.prompt ?? '写一个关于小狐狸的睡前故事',
    voiceId: overrides?.voiceId ?? 'voice-cherry-frozen',
  });
  return completeArtifact(draft, {
    finalStoryText: overrides?.storyText ?? '从前有只小狐狸，它帮助了森林里的小动物。',
    title: overrides?.title,
  });
}

function makeDetailFixture(id: number, input: LibraryCreateInput): StoryWorkDetailDTO {
  const now = '2026-09-12T10:00:00.000Z';
  return {
    id,
    title: typeof input.title === 'string' && input.title ? input.title : '冻结标题',
    excerpt: input.storyText.slice(0, 20),
    voiceId: typeof input.voiceId === 'string' ? input.voiceId : '',
    contentHash: `hash-${id}`,
    favoritedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    audio: { status: 'missing', durationMs: null },
    prompt: input.prompt,
    storyText: input.storyText,
    sourceMessageId: typeof input.sourceMessageId === 'string' ? input.sourceMessageId : null,
  };
}

function getArtifactByAssistantId(assistantId: string) {
  const msg = useChatStore.getState().messages.find((m) => m.id === assistantId) as ChatMsg | undefined;
  assert.ok(msg, `消息必须存在: ${assistantId}`);
  const part = (msg as ChatMsg).parts?.find((p) => p.type === 'storyArtifact') as
    | { type: 'storyArtifact'; artifact: Record<string, unknown> }
    | undefined;
  assert.ok(part, `消息必须持有 storyArtifact: ${assistantId}`);
  return { msg: msg as ChatMsg, artifact: part.artifact };
}

function conflictError(): Error & { code?: string; data?: { code?: string } } {
  const err = new Error('CONFLICT: same sourceMessageId with different contentHash') as Error & {
    code?: string;
    data?: { code?: string };
  };
  err.code = 'CONFLICT';
  return err;
}

async function main(): Promise<void> {
  console.log('=== M4-03-01: Complete 精确映射 title/prompt/storyText/voiceId/sourceMessageId ===');
  {
    const complete = makeCompleteFixture({
      sourceMessageId: 'msg-map-001',
      storyText: '精确映射正文-01',
      prompt: '精确映射 prompt-01',
      voiceId: 'voice-frozen-01',
      title: '精确映射标题',
    });
    const seen: LibraryCreateInput[] = [];
    const dto = makeDetailFixture(101, {
      title: complete.title,
      prompt: complete.prompt as string,
      storyText: complete.storyText,
      voiceId: complete.voiceId,
      sourceMessageId: complete.sourceMessageId,
    });
    const result = await promoteStoryArtifact(complete, {
      create: async (input) => {
        seen.push(input);
        return dto;
      },
    });
    assert.strictEqual(result.id, 101);
    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual(
      seen[0],
      {
        title: '精确映射标题',
        prompt: '精确映射 prompt-01',
        storyText: '精确映射正文-01',
        voiceId: 'voice-frozen-01',
        sourceMessageId: 'msg-map-001',
      },
      '必须精确映射五字段，不增不减',
    );
    // buildPromotionInput 同样精确（无 idempotencyKey 等自造字段）。
    // 直接调用前必须先过门控：类型本身要求 prompt snapshot 非空。
    assertPromotableArtifact(complete);
    const built = buildPromotionInput(complete);
    assert.deepStrictEqual(Object.keys(built).sort(), [
      'prompt',
      'sourceMessageId',
      'storyText',
      'title',
      'voiceId',
    ]);
    console.log('PASS: M4-03-01 exact mapping');
  }

  console.log('=== M4-03-02: promotion 时改 Settings.voice 仍用生成开始快照 ===');
  {
    // 冻结快照：生成开始时 voice=voice-frozen-02。
    const complete = makeCompleteFixture({
      sourceMessageId: 'msg-frozen-002',
      voiceId: 'voice-frozen-02',
      prompt: '冻结 prompt-02',
      storyText: '冻结正文-02',
    });
    // 模拟 promotion 时 Settings 已被改为 voice-changed-late。
    let currentSettingsVoice = 'voice-changed-late';
    void currentSettingsVoice;
    const seen: LibraryCreateInput[] = [];
    const dto = makeDetailFixture(102, {
      title: complete.title,
      prompt: complete.prompt as string,
      storyText: complete.storyText,
      voiceId: complete.voiceId,
      sourceMessageId: complete.sourceMessageId,
    });
    const result = await promoteStoryArtifact(complete, {
      // 桩 create 故意无视外部 currentSettingsVoice，只透传 adapter 给的 input。
      create: async (input) => {
        seen.push(input);
        assert.strictEqual(
          input.voiceId,
          'voice-frozen-02',
          '必须使用生成开始时快照，不得回读当前 Settings',
        );
        assert.strictEqual(input.prompt, '冻结 prompt-02');
        return dto;
      },
    });
    assert.strictEqual(result.id, 102);
    assert.strictEqual(seen.length, 1);

    // 快照 plumbing：submit 冻结后改快照入参，不影响已冻结 draft。
    resetBaseline();
    useChatStore.getState().dispatch({
      type: 'user.submit',
      content: '讲个小狐狸故事',
      promptSnapshot: '讲个小狐狸故事',
      voiceSnapshot: 'voice-frozen-submit',
    } as DispatchArg);
    const assistantId = useChatStore.getState().selectors.latestAssistantMessage()?.id as string;
    const { artifact } = getArtifactByAssistantId(assistantId);
    assert.strictEqual(artifact.prompt, '讲个小狐狸故事');
    assert.strictEqual(artifact.voiceId, 'voice-frozen-submit');
    // 后续 Settings 变更（新 submit 用新 voice）不得回写旧 draft。
    useChatStore.getState().dispatch({
      type: 'user.submit',
      content: '再讲一个',
      promptSnapshot: '再讲一个',
      voiceSnapshot: 'voice-changed-late',
    } as DispatchArg);
    const stillOld = getArtifactByAssistantId(assistantId);
    assert.strictEqual(stillOld.artifact.voiceId, 'voice-frozen-submit', '已冻结 draft 不得被后改 Settings 污染');
    assert.strictEqual(stillOld.artifact.prompt, '讲个小狐狸故事');
    console.log('PASS: M4-03-02 frozen snapshot wins over late Settings');
  }

  console.log('=== M4-03-03: 同 source+同文重试返回同 StoryWork，不自造 key ===');
  {
    const first = makeCompleteFixture({
      sourceMessageId: 'msg-idem-003',
      storyText: '幂等正文-同文',
      prompt: '幂等 prompt-首次',
      voiceId: 'voice-idem',
    });
    // promotion_failed 同源同文（retry source）同样可 promotion。
    const failed: PromotionFailedChatArtifact = markPromotionFailed(startPromotion(first), {
      error: 'timeout-once',
    });
    assert.strictEqual(failed.sourceMessageId, 'msg-idem-003');
    assert.strictEqual(failed.storyText, '幂等正文-同文');

    const seen: LibraryCreateInput[] = [];
    // 模拟 M2 facade：同源同 hash 返回同一 Work（同一 id），不新增。
    const canonical = makeDetailFixture(303, {
      title: first.title,
      prompt: first.prompt as string,
      storyText: first.storyText,
      voiceId: first.voiceId,
      sourceMessageId: first.sourceMessageId,
    });
    const fakeCreate = async (input: LibraryCreateInput): Promise<StoryWorkDetailDTO> => {
      seen.push(input);
      // 断言 adapter 未自造任何 client-side idempotency key。
      assert.strictEqual(
        (input as Record<string, unknown>).idempotencyKey,
        undefined,
        'adapter 不得自造 client-side idempotency key',
      );
      assert.strictEqual((input as Record<string, unknown>).idempotency_key, undefined);
      return canonical;
    };
    const r1 = await promoteStoryArtifact(first, { create: fakeCreate });
    const r2 = await promoteStoryArtifact(failed, { create: fakeCreate });
    assert.strictEqual(r1.id, 303);
    assert.strictEqual(r2.id, 303, '同源同文重试必须返回同一 StoryWork id');
    assert.strictEqual(seen.length, 2);
    assert.deepStrictEqual(seen[0], seen[1], '两次 input 必须完全一致（同 source+同文）');

    // 静态：adapter 源码不得出现自造 key 字样。
    const adapterPath = path.resolve(process.cwd(), 'lib/client/storyArtifactPromotion.ts');
    const adapterContent = fs.readFileSync(adapterPath, 'utf8');
    assert.strictEqual(
      adapterContent.toLowerCase().includes('idempotencykey'),
      false,
      'adapter 源码不得自造 idempotencyKey',
    );
    assert.strictEqual(adapterContent.includes('idempotency_key'), false);
    console.log('PASS: M4-03-03 idempotent same Work without client key');
  }

  console.log('=== M4-03-04: 同 source+异文 CONFLICT 原样上抛 ===');
  {
    const complete = makeCompleteFixture({
      sourceMessageId: 'msg-conflict-004',
      storyText: '原文-04',
    });
    const expected = conflictError();
    let calls = 0;
    let caught: unknown = null;
    try {
      await promoteStoryArtifact(complete, {
        create: async () => {
          calls += 1;
          throw expected;
        },
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, '必须抛出 CONFLICT');
    assert.strictEqual(caught, expected, '必须原样暴露同一错误对象，不吞错不包装');
    assert.strictEqual((caught as { code?: string }).code, 'CONFLICT');
    assert.strictEqual(calls, 1, '不得自动换 sourceMessageId 重试，调用次数必须为 1');

    // 异文输入同样原样上抛（input carrying different storyText）。
    const different = makeCompleteFixture({
      sourceMessageId: 'msg-conflict-004',
      storyText: '异文-04-必然冲突',
    });
    let calls2 = 0;
    await assert.rejects(
      promoteStoryArtifact(different, {
        create: async () => {
          calls2 += 1;
          throw conflictError();
        },
      }),
      /CONFLICT/,
    );
    assert.strictEqual(calls2, 1);
    console.log('PASS: M4-03-04 conflict passthrough');
  }

  console.log('=== M4-03-05: draft/interrupted/legacy fail-fast 且 create=0 ===');
  {
    let calls = 0;
    const countingCreate = async (input: LibraryCreateInput): Promise<StoryWorkDetailDTO> => {
      calls += 1;
      return makeDetailFixture(999, input);
    };

    const draft = createDraftArtifact({ sourceMessageId: 'msg-reject-draft', initialText: '草稿' });
    await assert.rejects(promoteStoryArtifact(draft, { create: countingCreate }), /不可 promotion/);

    const interrupted = interruptArtifact(
      createDraftArtifact({ sourceMessageId: 'msg-reject-int', initialText: '草稿-int' }),
    );
    await assert.rejects(promoteStoryArtifact(interrupted, { create: countingCreate }), /不可 promotion/);

    // ready / promoting 同样拒绝（仅 complete / promotion_failed 可入库）。
    const readyBase = makeCompleteFixture({ sourceMessageId: 'msg-reject-ready' });
    const ready = markPromotionSuccess(startPromotion(readyBase), { storyWorkId: 555 });
    await assert.rejects(promoteStoryArtifact(ready, { create: countingCreate }), /不可 promotion/);
    const promoting = startPromotion(makeCompleteFixture({ sourceMessageId: 'msg-reject-promoting' }));
    await assert.rejects(promoteStoryArtifact(promoting, { create: countingCreate }), /不可 promotion/);

    // legacy StoryCard 绝非 Artifact，必须拒绝。
    const legacyCard = { type: 'storyCard', storyText: '历史正文', audioUrl: 'blob:mock' };
    await assert.rejects(
      promoteStoryArtifact(legacyCard, { create: countingCreate }),
      /Legacy|不可 promotion/,
    );
    await assert.rejects(promoteStoryArtifact(null, { create: countingCreate }), /必须为 complete/);
    assert.throws(
      () => assertPromotableArtifact(draft),
      /不可 promotion/,
    );

    assert.strictEqual(calls, 0, '非法输入必须 fail-fast，library.create 调用次数=0');
    console.log('PASS: M4-03-05 fail-fast with zero create');
  }

  console.log('=== M4-03-08: 缺 mandatory prompt snapshot 必须 fail-fast 且 create=0 ===');
  {
    let calls = 0;
    const countingCreate = async (input: LibraryCreateInput): Promise<StoryWorkDetailDTO> => {
      calls += 1;
      return makeDetailFixture(888, input);
    };

    // 08-1 真实领域对象：prompt omitted 全程走合法状态机（draft → complete），
    // M4-01 contract 允许 prompt 缺失，但 promotion 边界必须 fail-fast。
    const noPromptDraft = createDraftArtifact({
      sourceMessageId: 'msg-no-prompt-008',
      initialText: '无 prompt 草稿正文',
      // prompt omitted（生成时未冻结快照）
    });
    const noPromptComplete = completeArtifact(noPromptDraft, {
      finalStoryText: '无 prompt 完成正文-08',
    });
    assert.strictEqual(noPromptComplete.status, 'complete');
    assert.strictEqual(noPromptComplete.prompt, undefined);
    await assert.rejects(
      promoteStoryArtifact(noPromptComplete, { create: countingCreate }),
      /mandatory promotion snapshot/,
    );
    assert.throws(
      () => assertPromotableArtifact(noPromptComplete),
      /mandatory promotion snapshot/,
    );

    // 同一缺 snapshot 对象走 promotion_failed 重试源同样拒绝。
    const noPromptFailed: PromotionFailedChatArtifact = markPromotionFailed(
      startPromotion(noPromptComplete),
      { error: 'timeout-once' },
    );
    await assert.rejects(
      promoteStoryArtifact(noPromptFailed, { create: countingCreate }),
      /mandatory promotion snapshot/,
    );

    // 空白 prompt（'' / 全空格）同样视为缺 snapshot。
    const blankComplete = makeCompleteFixture({ sourceMessageId: 'msg-blank-008' });
    for (const blank of ['', '   ']) {
      await assert.rejects(
        promoteStoryArtifact({ ...blankComplete, prompt: blank }, { create: countingCreate }),
        /mandatory promotion snapshot/,
      );
    }

    // 08-2 forged unknown：裸 { artifactType: 'story', status: 'complete' } 无 prompt，必须拒绝。
    await assert.rejects(
      promoteStoryArtifact({ artifactType: 'story', status: 'complete' }, { create: countingCreate }),
      /mandatory promotion snapshot/,
    );
    await assert.rejects(
      promoteStoryArtifact(
        { artifactType: 'story', status: 'promotion_failed' },
        { create: countingCreate },
      ),
      /mandatory promotion snapshot/,
    );

    assert.strictEqual(calls, 0, '缺 prompt snapshot 必须 fail-fast，library.create 调用次数=0');

    // 静态：adapter 不得用 cast 绕过 prompt 类型（类型本身守 contract）。
    const adapterPath = path.resolve(process.cwd(), 'lib/client/storyArtifactPromotion.ts');
    const adapterContent = fs.readFileSync(adapterPath, 'utf8');
    assert.strictEqual(
      adapterContent.includes('artifact.prompt as'),
      false,
      'adapter 不得用 cast 伪造 prompt 字符串',
    );
    console.log('PASS: M4-03-08 missing prompt snapshot fail-fast with zero create');
  }

  console.log('=== M4-03-06: adapter 仅消费 frozen libraryClient.create（静态） ===');
  {
    const adapterPath = path.resolve(process.cwd(), 'lib/client/storyArtifactPromotion.ts');
    const adapterContent = fs.readFileSync(adapterPath, 'utf8');
    // 必须消费冻结门面。
    assert.ok(
      adapterContent.includes('libraryClient.create') || adapterContent.includes('from @/lib/client/library'),
      '必须消费 frozen libraryClient.create',
    );
    const forbidden: RegExp[] = [
      /from\s+['"].*lib\/db['"]/,
      /require\(['"].*lib\/db['"]\)/,
      /from\s+['"].*prisma['"]/i,
      /from\s+['"].*lib\/server\//,
      /from\s+['"].*server\/storyWork['"]/,
      /from\s+['"].*lib\/trpc\/client['"]/,
      /from\s+['"]@trpc\/client['"]/,
      /promoteArtifact/,
    ];
    for (const re of forbidden) {
      assert.strictEqual(re.test(adapterContent), false, `adapter 违规引用：${re}`);
    }
    // M2 facade frozen：严禁为 M4 新增 promoteArtifact procedure。
    const routerFiles = fs
      .readdirSync(path.resolve(process.cwd(), 'lib/trpc/routers'))
      .filter((f) => f.endsWith('.ts'));
    for (const f of routerFiles) {
      const content = fs.readFileSync(path.resolve(process.cwd(), 'lib/trpc/routers', f), 'utf8');
      assert.strictEqual(
        content.includes('promoteArtifact'),
        false,
        `M2 facade frozen：${f} 不得新增 promoteArtifact`,
      );
    }
    console.log('PASS: M4-03-06 frozen facade only');
  }

  console.log('=== M4-03-07: snapshot plumbing（submit/retry 冻结，不自动 promotion） ===');
  {
    // 07-1 submit 把 action.content 写进 draft.prompt。
    resetBaseline();
    useChatStore.getState().dispatch({ type: 'user.submit', content: '讲个森林故事' } as DispatchArg);
    const firstAssistant = useChatStore.getState().selectors.latestAssistantMessage()?.id as string;
    const first = getArtifactByAssistantId(firstAssistant);
    assert.strictEqual(first.artifact.status, 'draft');
    assert.strictEqual(first.artifact.prompt, '讲个森林故事', 'submit 必须把 action.content 写进 draft.prompt');
    assert.strictEqual(first.artifact.sourceMessageId, firstAssistant);

    // 07-2 显式 voice 快照冻结进同一 draft。
    resetBaseline();
    useChatStore.getState().dispatch({
      type: 'user.submit',
      content: '讲个月亮故事',
      promptSnapshot: '讲个月亮故事',
      voiceSnapshot: 'voice-actual-request',
    } as DispatchArg);
    const voiceAssistant = useChatStore.getState().selectors.latestAssistantMessage()?.id as string;
    const voiceFrozen = getArtifactByAssistantId(voiceAssistant);
    assert.strictEqual(voiceFrozen.artifact.prompt, '讲个月亮故事');
    assert.strictEqual(voiceFrozen.artifact.voiceId, 'voice-actual-request');

    // 07-3 retry 重建新 assistant/sourceMessageId，且 prompt+voice 正确进入新 attempt。
    resetBaseline();
    useChatStore.getState().dispatch({
      type: 'user.submit',
      content: '原始 prompt-07',
      promptSnapshot: '原始 prompt-07',
      voiceSnapshot: 'voice-retry-frozen',
    } as DispatchArg);
    const beforeRetryAssistant = useChatStore.getState().selectors.latestAssistantMessage()?.id as string;
    useChatStore.getState().dispatch({ type: 'stream.fail', error: 'boom', messageId: beforeRetryAssistant } as DispatchArg);
    const failedArtifact = getArtifactByAssistantId(beforeRetryAssistant);
    assert.strictEqual(failedArtifact.artifact.status, 'interrupted');
    useChatStore.getState().dispatch({
      type: 'user.retry',
      promptSnapshot: '原始 prompt-07',
      voiceSnapshot: 'voice-retry-frozen',
    } as DispatchArg);
    const afterRetryAssistant = useChatStore.getState().selectors.latestAssistantMessage()?.id as string;
    assert.ok(afterRetryAssistant && afterRetryAssistant !== beforeRetryAssistant, 'retry 必须重建新 assistant/sourceMessageId');
    const retried = getArtifactByAssistantId(afterRetryAssistant);
    assert.strictEqual(retried.artifact.status, 'draft');
    assert.strictEqual(retried.artifact.sourceMessageId, afterRetryAssistant);
    assert.strictEqual(retried.artifact.prompt, '原始 prompt-07', '新 attempt 必须携带原 prompt 快照');
    assert.strictEqual(retried.artifact.voiceId, 'voice-retry-frozen', '新 attempt 必须携带本次实际 voice 快照');

    // 07-4 retry 缺省回退：prompt 取配对失败 user 内容。
    resetBaseline();
    useChatStore.getState().dispatch({ type: 'user.submit', content: '回退 prompt-07' } as DispatchArg);
    const fallbackAssistant = useChatStore.getState().selectors.latestAssistantMessage()?.id as string;
    useChatStore.getState().dispatch({ type: 'stream.fail', error: 'boom', messageId: fallbackAssistant } as DispatchArg);
    useChatStore.getState().dispatch({ type: 'user.retry' } as DispatchArg);
    const fallbackNew = useChatStore.getState().selectors.latestAssistantMessage()?.id as string;
    assert.notStrictEqual(fallbackNew, fallbackAssistant);
    const fallbackArtifact = getArtifactByAssistantId(fallbackNew);
    assert.strictEqual(fallbackArtifact.artifact.prompt, '回退 prompt-07');

    // 07-5 本步不自动触发 promotion：store/flow 不得直调 library.create / adapter。
    const storePath = path.resolve(process.cwd(), 'stores/chatStore.ts');
    const flowPath = path.resolve(process.cwd(), 'app/services/chatFlow.ts');
    const storeContent = fs.readFileSync(storePath, 'utf8');
    const flowContent = fs.readFileSync(flowPath, 'utf8');
    assert.strictEqual(storeContent.includes('library.create'), false, 'M4-03 store 不得自动触发 promotion');
    assert.strictEqual(flowContent.includes('library.create'), false, 'M4-03 flow 不得自动触发 promotion');
    assert.strictEqual(storeContent.includes('storyArtifactPromotion'), false);
    assert.strictEqual(flowContent.includes('storyArtifactPromotion'), false, '自动 promotion 留 M4-04，本步只做 I/O 与快照');
    // chatFlow 必须单次冻结并透传（submit/retry 均带 promptSnapshot/voiceSnapshot，且 execute 用同一 frozenVoice）。
    assert.ok(flowContent.includes('promptSnapshot'), 'chatFlow 必须冻结 promptSnapshot');
    assert.ok(flowContent.includes('voiceSnapshot'), 'chatFlow 必须冻结 voiceSnapshot');
    assert.ok(flowContent.includes('frozenVoiceId'), 'chatFlow 必须单次捕获 frozenVoiceId 并复用');
    console.log('PASS: M4-03-07 snapshot plumbing without auto promotion');
  }

  console.log('\nALL STORY ARTIFACT PROMOTION TESTS PASSED SUCCESSFULLY');
}

const testPromise = main()
  .then(() => {
    console.log('ALL STORY ARTIFACT PROMOTION TESTS PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('TEST FAILED:', err);
    process.exit(1);
  })
  .finally(() => {
    useChatStore.getState().reset();
  });

export default testPromise;
