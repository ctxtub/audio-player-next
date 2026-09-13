import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 中文注释：M4-02 解耦回归——stream complete 与 Artifact completion 解耦（draft→complete 仅由 story_complete 驱动）。
// M4-04 更新：story_complete 随后同步进入 promoting 并 kick 唯一 async promotion，
// complete 为瞬态（同步不再可观察）；本文件注入永不结算的 promotion 桩，锁定 draft→(complete)→promoting
// 的同步编排语义与 done 正交性，ready/failed 终态由 E2E-08-04 覆盖。
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
    summarizeContext: async () => '探针摘要-M402',
  },
} as unknown as NodeModule;

const { useChatStore } = nodeRequire('../../../stores/chatStore') as {
  useChatStore: typeof import('../../../stores/chatStore').useChatStore;
};

// 中文注释：M4-04 编排桩——永不结算，锁定同步编排语义（complete 瞬态→promoting），绝不触达真实网络。
const { setPromotionCreateOverride } = nodeRequire(
  '../../../lib/client/chatPromotionOrchestration',
) as {
  setPromotionCreateOverride: typeof import('../../../lib/client/chatPromotionOrchestration').setPromotionCreateOverride;
};
let promotionCreateCalls = 0;
setPromotionCreateOverride(() => {
  promotionCreateCalls += 1;
  return new Promise<never>(() => {});
});

type DispatchArg = Parameters<ReturnType<typeof useChatStore.getState>['dispatch']>[0];
type ChatMsg = ReturnType<typeof useChatStore.getState>['messages'][number];

function resetBaseline(): void {
  useChatStore.getState().reset();
  useChatStore.setState({ syncEnabled: false });
  promotionCreateCalls = 0;
}

function submitAndGetAssistantId(content = '讲个睡前故事'): string {
  useChatStore.getState().dispatch({ type: 'user.submit', content } as DispatchArg);
  const assistantId = useChatStore.getState().selectors.latestAssistantMessage()?.id;
  assert.ok(assistantId, 'assistant 占位必须存在');
  return assistantId as string;
}

function getMessage(id: string): ChatMsg | undefined {
  return useChatStore.getState().messages.find((m) => m.id === id);
}

function getArtifact(id: string) {
  const msg = getMessage(id);
  assert.ok(msg, `消息必须存在: ${id}`);
  const part = (msg as ChatMsg).parts?.find((p) => p.type === 'storyArtifact') as
    | { type: 'storyArtifact'; artifact: { status: string; sourceMessageId: string; storyText: string; storyWorkId?: unknown } }
    | undefined;
  assert.ok(part, `消息必须持有 storyArtifact: ${id}`);
  return { msg: msg as ChatMsg, part };
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

function failAttempt(id: string, error = 'boom'): void {
  useChatStore.getState().dispatch({ type: 'stream.fail', error, messageId: id } as DispatchArg);
}

function abortAttempt(id: string, reason = 'aborted'): void {
  useChatStore.getState().dispatch({ type: 'stream.abort', messageId: id, reason } as DispatchArg);
}

function getUserMessageByIndex(order: number): ChatMsg {
  const users = useChatStore.getState().messages.filter((m) => m.role === 'user');
  assert.ok(users[order], `第 ${order} 条 user 必须存在`);
  return users[order] as ChatMsg;
}

async function main(): Promise<void> {
  console.log('=== M4-02-01: sourceMessageId === assistantMessage.id ===');
  {
    resetBaseline();
    const assistantId = submitAndGetAssistantId();
    const { part } = getArtifact(assistantId);
    assert.strictEqual(part.artifact.sourceMessageId, assistantId, 'sourceMessageId 必须恒为 assistant message id');
    assert.strictEqual(part.artifact.status, 'draft', '新建即 draft');
    console.log('PASS: M4-02-01 source identity');
  }

  console.log('=== M4-02-02: duplicate story_complete 同一 attempt 仅一次 draft→complete→promoting ===');
  {
    resetBaseline();
    const assistantId = submitAndGetAssistantId();
    intentStory(assistantId);
    delta(assistantId, '从前');
    storyComplete(assistantId, '从前有座山');
    const first = getArtifact(assistantId);
    // M4-04：complete 为瞬态，同步可观察到 promoting，且只 kick 一次 promotion。
    assert.strictEqual(first.part.artifact.status, 'promoting');
    assert.strictEqual(first.part.artifact.storyText, '从前有座山');
    assert.strictEqual(promotionCreateCalls, 1, '首次 story_complete 必须恰好 kick 一次 promotion');
    // 重复到达：幂等忽略，不抛错、不新写、不改文本、不产生第二次 promotion。
    storyComplete(assistantId, '从前有座山');
    const second = getArtifact(assistantId);
    assert.strictEqual(second.part.artifact.status, 'promoting');
    assert.strictEqual(second.part.artifact.storyText, '从前有座山');
    assert.strictEqual(promotionCreateCalls, 1, 'duplicate story_complete 不得产生第二次 promotion');
    assert.strictEqual(
      (second.msg.parts ?? []).filter((p) => p.type === 'storyArtifact').length,
      1,
      '不得增殖 Artifact 片段',
    );
    console.log('PASS: M4-02-02 duplicate idempotent');
  }

  console.log('=== M4-02-03: story_complete → done 仍是同一个 promoting（done 只标记送达） ===');
  {
    resetBaseline();
    const assistantId = submitAndGetAssistantId();
    intentStory(assistantId);
    storyComplete(assistantId, '完整故事正文-03');
    const before = getArtifact(assistantId);
    assert.strictEqual(before.part.artifact.status, 'promoting');
    finish(assistantId);
    const after = getArtifact(assistantId);
    assert.strictEqual(after.part.artifact.status, 'promoting', 'done 不得改变 Artifact 状态');
    assert.strictEqual(after.part.artifact.storyText, before.part.artifact.storyText, 'done 不得改写正文');
    assert.strictEqual(after.part.artifact.sourceMessageId, assistantId);
    assert.strictEqual(after.msg.status, 'delivered', 'done 标记 delivered');
    assert.strictEqual((after.part.artifact as { storyWorkId?: unknown }).storyWorkId, undefined);
    console.log('PASS: M4-02-03 promoting stable across done');
  }

  console.log('=== M4-02-04: done → story_complete 不因 done 提前制造 ready/StoryWork ===');
  {
    resetBaseline();
    const assistantId = submitAndGetAssistantId();
    intentStory(assistantId);
    delta(assistantId, '草稿片段');
    finish(assistantId);
    const mid = getArtifact(assistantId);
    assert.strictEqual(mid.part.artifact.status, 'draft', 'done 不得隐式 complete');
    assert.strictEqual(mid.msg.status, 'delivered');
    assert.strictEqual((mid.part.artifact as { storyWorkId?: unknown }).storyWorkId, undefined);
    // 随后 story_complete 同步进入 promoting（M4-04 编排），但绝不直接 ready。
    storyComplete(assistantId, '草稿片段完整版');
    const after = getArtifact(assistantId);
    assert.strictEqual(after.part.artifact.status, 'promoting');
    assert.strictEqual((after.part.artifact as { storyWorkId?: unknown }).storyWorkId, undefined);
    assert.ok(!('storyWorkId' in after.part.artifact) || after.part.artifact.storyWorkId === undefined);
    console.log('PASS: M4-02-04 done-first no premature ready');
  }

  console.log('=== M4-02-05: cross-attempt terminal isolation（finish/fail/abort paired user + stale）===');
  {
    // 05-1 并发双 attempt：stale A complete 不得污染 B（原有冻结语义保留）。
    resetBaseline();
    // 并发双 attempt：A 先建，B 后建；stale A complete 不得污染 B。
    const idA = submitAndGetAssistantId('第一问-A');
    intentStory(idA);
    delta(idA, 'A-草稿');
    const idB = submitAndGetAssistantId('第二问-B');
    assert.notStrictEqual(idA, idB, '不同 attempt 必须不同 id');
    intentStory(idB);
    delta(idB, 'B-草稿');
    storyComplete(idA, 'A-完整正文-stale');
    const artifactA = getArtifact(idA);
    const artifactB = getArtifact(idB);
    // M4-04：A 同步进入 promoting（promotion 在途），B 仍为 draft。
    assert.strictEqual(artifactA.part.artifact.status, 'promoting');
    assert.strictEqual(artifactA.part.artifact.storyText, 'A-完整正文-stale');
    assert.strictEqual(artifactB.part.artifact.status, 'draft', 'stale A 不得推进 B');
    assert.strictEqual(artifactB.part.artifact.storyText, 'B-草稿');
    assert.strictEqual(artifactB.part.artifact.sourceMessageId, idB);
    console.log('PASS: M4-02-05-1 stale complete isolation');

    // 05-2 finish(A) 只配对 User A：userA delivered / assistantA delivered / userB 仍 sending / assistantB 不变。
    resetBaseline();
    const finishA = submitAndGetAssistantId('第一问-A-finish');
    intentStory(finishA);
    delta(finishA, 'A-草稿-finish');
    const finishB = submitAndGetAssistantId('第二问-B-finish');
    intentStory(finishB);
    delta(finishB, 'B-草稿-finish');
    const finishUserA = getUserMessageByIndex(0);
    const finishUserB = getUserMessageByIndex(1);
    assert.strictEqual(finishUserA.status, 'sending');
    assert.strictEqual(finishUserB.status, 'sending');
    finish(finishA);
    const finishUserAAfter = getMessage(finishUserA.id) as ChatMsg;
    const finishUserBAfter = getMessage(finishUserB.id) as ChatMsg;
    const finishAssistantAAfter = getMessage(finishA) as ChatMsg;
    const finishAssistantBAfter = getMessage(finishB) as ChatMsg;
    assert.strictEqual(finishUserAAfter.status, 'delivered', 'finish(A) 必须只配对 User A delivered');
    assert.strictEqual(finishAssistantAAfter.status, 'delivered', 'finish(A) assistantA delivered');
    assert.strictEqual(finishUserBAfter.status, 'sending', 'finish(A) 不得污染 User B');
    assert.strictEqual(finishAssistantBAfter.status, 'sending', 'finish(A) 不得污染 Assistant B');
    const finishArtifactB = getArtifact(finishB);
    assert.strictEqual(finishArtifactB.part.artifact.status, 'draft', 'finish(A) 不得推进 B Artifact');
    assert.strictEqual(finishArtifactB.part.artifact.storyText, 'B-草稿-finish');
    assert.strictEqual(finishArtifactB.part.artifact.sourceMessageId, finishB);
    console.log('PASS: M4-02-05-2 finish paired isolation');

    // 05-3 fail(A) 只配对 User A：userA failed / assistantA interrupted / userB 仍 sending / B Artifact 不变。
    resetBaseline();
    const failA = submitAndGetAssistantId('第一问-A-fail');
    intentStory(failA);
    delta(failA, 'A-草稿-fail');
    const failB = submitAndGetAssistantId('第二问-B-fail');
    intentStory(failB);
    delta(failB, 'B-草稿-fail');
    const failUserA = getUserMessageByIndex(0);
    const failUserB = getUserMessageByIndex(1);
    failAttempt(failA, 'boom-A');
    const failUserAAfter = getMessage(failUserA.id) as ChatMsg;
    const failUserBAfter = getMessage(failUserB.id) as ChatMsg;
    const failAssistantAAfter = getMessage(failA) as ChatMsg;
    const failAssistantBAfter = getMessage(failB) as ChatMsg;
    assert.strictEqual(failUserAAfter.status, 'failed', 'fail(A) 必须只配对 User A failed');
    assert.strictEqual(failAssistantAAfter.status, 'failed', 'fail(A) assistantA failed');
    assert.strictEqual(failUserBAfter.status, 'sending', 'fail(A) 不得污染 User B');
    assert.strictEqual(failAssistantBAfter.status, 'sending', 'fail(A) 不得污染 Assistant B');
    const failArtifactA = getArtifact(failA);
    assert.strictEqual(failArtifactA.part.artifact.status, 'interrupted', 'fail(A) draft→interrupted');
    const failArtifactB = getArtifact(failB);
    assert.strictEqual(failArtifactB.part.artifact.status, 'draft', 'fail(A) 不得推进 B Artifact');
    assert.strictEqual(failArtifactB.part.artifact.storyText, 'B-草稿-fail');
    assert.strictEqual(failArtifactB.part.artifact.sourceMessageId, failB);
    console.log('PASS: M4-02-05-3 fail paired isolation');

    // 05-4 abort(A) 只配对 User A：同 fail（userA failed / userB 仍 sending / B Artifact 不变）。
    resetBaseline();
    const abortA = submitAndGetAssistantId('第一问-A-abort');
    intentStory(abortA);
    delta(abortA, 'A-草稿-abort');
    const abortB = submitAndGetAssistantId('第二问-B-abort');
    intentStory(abortB);
    delta(abortB, 'B-草稿-abort');
    const abortUserA = getUserMessageByIndex(0);
    const abortUserB = getUserMessageByIndex(1);
    abortAttempt(abortA, 'aborted');
    const abortUserAAfter = getMessage(abortUserA.id) as ChatMsg;
    const abortUserBAfter = getMessage(abortUserB.id) as ChatMsg;
    const abortAssistantAAfter = getMessage(abortA) as ChatMsg;
    const abortAssistantBAfter = getMessage(abortB) as ChatMsg;
    assert.strictEqual(abortUserAAfter.status, 'failed', 'abort(A) 必须只配对 User A failed');
    assert.strictEqual(abortAssistantAAfter.status, 'failed', 'abort(A) assistantA failed');
    assert.strictEqual(abortUserBAfter.status, 'sending', 'abort(A) 不得污染 User B');
    assert.strictEqual(abortAssistantBAfter.status, 'sending', 'abort(A) 不得污染 Assistant B');
    const abortArtifactA = getArtifact(abortA);
    assert.strictEqual(abortArtifactA.part.artifact.status, 'interrupted', 'abort(A) draft→interrupted');
    const abortArtifactB = getArtifact(abortB);
    assert.strictEqual(abortArtifactB.part.artifact.status, 'draft', 'abort(A) 不得推进 B Artifact');
    assert.strictEqual(abortArtifactB.part.artifact.storyText, 'B-草稿-abort');
    assert.strictEqual(abortArtifactB.part.artifact.sourceMessageId, abortB);
    console.log('PASS: M4-02-05-4 abort paired isolation');

    // retry 分支：A 失败被清理后，stale A 事件不得复活、不得碰 B。
    resetBaseline();
    const retryA = submitAndGetAssistantId('重试前-A');
    intentStory(retryA);
    useChatStore.getState().dispatch({ type: 'stream.fail', error: 'boom', messageId: retryA } as DispatchArg);
    useChatStore.getState().dispatch({ type: 'user.retry' } as DispatchArg);
    const retryB = useChatStore.getState().selectors.latestAssistantMessage()?.id as string;
    assert.ok(retryB && retryB !== retryA, 'retry 必须产生新 attempt id');
    storyComplete(retryA, 'stale-A-必须忽略');
    assert.strictEqual(getMessage(retryA), undefined, '已清理的 A 不得复活');
    const artifactRetryB = getArtifact(retryB);
    assert.strictEqual(artifactRetryB.part.artifact.status, 'draft');

    // 05-5 retry 清掉 A 后，stale finish/fail/abort(A) 均不得碰 B 的 user + assistant。
    {
      const retryUsers = useChatStore.getState().messages.filter((m) => m.role === 'user');
      assert.strictEqual(retryUsers.length, 1, 'retry 后应仅剩复用 user + 新 assistant');
      const retryUserId = (retryUsers[0] as ChatMsg).id;
      const snapshotBefore = JSON.stringify(useChatStore.getState().messages);
      finish(retryA);
      assert.strictEqual(JSON.stringify(useChatStore.getState().messages), snapshotBefore, 'stale finish(A) 不得碰 B');
      failAttempt(retryA, 'stale-boom');
      assert.strictEqual(JSON.stringify(useChatStore.getState().messages), snapshotBefore, 'stale fail(A) 不得碰 B');
      abortAttempt(retryA, 'stale-aborted');
      assert.strictEqual(JSON.stringify(useChatStore.getState().messages), snapshotBefore, 'stale abort(A) 不得碰 B');
      const retryUserAfter = getMessage(retryUserId) as ChatMsg;
      const retryAssistantAfter = getMessage(retryB) as ChatMsg;
      assert.strictEqual(retryUserAfter.status, 'sending', 'stale terminal 不得改 B user');
      assert.strictEqual(retryAssistantAfter.status, 'sending', 'stale terminal 不得改 B assistant');
      const retryArtifactAfter = getArtifact(retryB);
      assert.strictEqual(retryArtifactAfter.part.artifact.status, 'draft', 'stale terminal 不得改 B Artifact');
      console.log('PASS: M4-02-05-5 retry stale terminal isolation');
    }

    // 05-6 静态守卫：三 terminal 共用同一 paired helper，不再按最后一条 sending user 修改。
    {
      const storePath = path.resolve(process.cwd(), 'stores/chatStore.ts');
      const storeContent = fs.readFileSync(storePath, 'utf8');
      assert.ok(
        storeContent.includes('const findUserIndexForAssistant'),
        '必须新增 findUserIndexForAssistant helper',
      );
      const helperUses = storeContent.split('findUserIndexForAssistant').length - 1;
      assert.ok(helperUses >= 4, `三 handler 必须共用同一 helper（定义+3处调用，实得 ${helperUses}）`);
      const legacyLastUserRe = /findLastIndex\([^)]*role\s*===\s*['"]user['"][^)]*sending/;
      assert.strictEqual(
        legacyLastUserRe.test(storeContent),
        false,
        'terminal 不得再按最后一条 sending user 修改（必须只改 paired user）',
      );
      console.log('PASS: M4-02-05-6 shared helper guard');
    }
    console.log('PASS: M4-02-05 stale isolation');
  }

  console.log('=== M4-02-06: resetChat/clear 后旧 complete 到达绝不复活 ===');
  {
    resetBaseline();
    const assistantId = submitAndGetAssistantId();
    intentStory(assistantId);
    storyComplete(assistantId, '旧故事-06');
    finish(assistantId);
    useChatStore.getState().resetChat();
    assert.strictEqual(useChatStore.getState().messages.length, 0, '清空后应为空');
    storyComplete(assistantId, '旧故事-06-stale');
    finish(assistantId);
    assert.strictEqual(useChatStore.getState().messages.length, 0, '旧事件不得复活 Artifact');
    console.log('PASS: M4-02-06 clear no resurrection');
  }

  console.log('=== M4-02-07: stream error/abort → interrupted，不出现 complete ===');
  {
    resetBaseline();
    const failId = submitAndGetAssistantId('失败用例');
    intentStory(failId);
    delta(failId, '未完成草稿');
    useChatStore.getState().dispatch({ type: 'stream.fail', error: 'net', messageId: failId } as DispatchArg);
    const failed = getArtifact(failId);
    assert.strictEqual(failed.part.artifact.status, 'interrupted', 'error 必须 draft→interrupted');
    // 随后 complete 不得覆盖 interrupted。
    storyComplete(failId, '迟到正文-不得覆盖');
    const stillFailed = getArtifact(failId);
    assert.strictEqual(stillFailed.part.artifact.status, 'interrupted');

    resetBaseline();
    const abortId = submitAndGetAssistantId('中断用例');
    intentStory(abortId);
    delta(abortId, '未完成草稿-abort');
    useChatStore.getState().dispatch({ type: 'stream.abort', messageId: abortId, reason: 'aborted' } as DispatchArg);
    const aborted = getArtifact(abortId);
    assert.strictEqual(aborted.part.artifact.status, 'interrupted', 'abort 必须 draft→interrupted');
    storyComplete(abortId, '迟到正文-abort-不得覆盖');
    const stillAborted = getArtifact(abortId);
    assert.strictEqual(stillAborted.part.artifact.status, 'interrupted');
    console.log('PASS: M4-02-07 interrupted terminal');
  }

  console.log('=== M4-02-08: 新生成路径静态/运行时守卫（StoryCard 0 / audioUrl 0 / library.create 0）===');
  {
    // 静态：旧写入路径已拆除（新生成链不再新写 StoryCardPart；legacy 读保留）。
    const storePath = path.resolve(process.cwd(), 'stores/chatStore.ts');
    const flowPath = path.resolve(process.cwd(), 'app/services/chatFlow.ts');
    const storeContent = fs.readFileSync(storePath, 'utf8');
    const flowContent = fs.readFileSync(flowPath, 'utf8');
    assert.strictEqual(storeContent.includes('stream.story_finish'), false, 'chatStore 不得再含旧 stream.story_finish');
    assert.strictEqual(flowContent.includes('stream.story_finish'), false, 'chatFlow 不得再派发旧 stream.story_finish');
    const storyCardWriteRe = /type:\s*['"]storyCard['"]/;
    assert.strictEqual(storyCardWriteRe.test(storeContent), false, 'chatStore 新生成链 StoryCardPart write 必须为 0');
    assert.strictEqual(storyCardWriteRe.test(flowContent), false, 'chatFlow StoryCardPart write 必须为 0');
    assert.strictEqual(storeContent.includes('library.create'), false, 'chatStore 不得直调 library.create（promotion 留 M4-03/04）');
    assert.strictEqual(flowContent.includes('library.create'), false, 'chatFlow 不得直调 library.create（promotion 留 M4-03/04）');
    // audioUrl 静态：新完成处理器内不得出现 audioUrl 写入语义。
    const completeHandlerSlice = (() => {
      const start = storeContent.indexOf("case 'stream.story_complete'");
      assert.ok(start >= 0, '必须存在 story_complete 处理器');
      const end = storeContent.indexOf("case 'stream.finish'", start);
      return storeContent.slice(start, end >= 0 ? end : start + 4000);
    })();
    assert.strictEqual(completeHandlerSlice.includes('audioUrl'), false, 'story_complete 处理器不得写入 audioUrl');

    // 运行时：完整新链无 StoryCard、无 audioUrl、无 StoryWork（M4-04：同步停在 promoting，在途未结算）。
    resetBaseline();
    const assistantId = submitAndGetAssistantId();
    intentStory(assistantId);
    delta(assistantId, '运行时');
    delta(assistantId, '正文');
    storyComplete(assistantId, '运行时正文完整版');
    finish(assistantId);
    const state = useChatStore.getState();
    const flat = JSON.stringify(state.messages);
    assert.ok(!flat.includes('"type":"storyCard"'), '运行时不得新写 StoryCardPart');
    assert.ok(!flat.includes('storyCard'), '运行时不得出现 storyCard 写入');
    assert.ok(!flat.includes('audioUrl'), '运行时不得写入 audioUrl（Modern Artifact 无该字段）');
    assert.ok(!flat.includes('storyWorkId'), '运行时不得出现 StoryWork（promoting 在途未结算，无 storyWorkId）');
    assert.ok(!flat.includes('library.create'), '运行时不得直调 library.create（唯一通道走 adapter）');
    assert.strictEqual(promotionCreateCalls, 1, '完整新链必须恰好 kick 一次 promotion');
    const { part } = getArtifact(assistantId);
    assert.strictEqual(part.artifact.status, 'promoting');
    assert.strictEqual('audioUrl' in (part.artifact as Record<string, unknown>), false);
    console.log('PASS: M4-02-08 static+runtime guards');
  }

  console.log('\nALL STORY COMPLETE DECOUPLING TESTS PASSED SUCCESSFULLY');
}

const testPromise = main()
  .then(() => {
    console.log('ALL STORY COMPLETE DECOUPLING TESTS PASSED SUCCESSFULLY!');
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
