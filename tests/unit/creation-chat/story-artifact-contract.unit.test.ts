import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ChatArtifact,
  ChatArtifactStatus,
  CompleteChatArtifact,
  DraftChatArtifact,
  InterruptedChatArtifact,
  PromotingChatArtifact,
  PromotionFailedChatArtifact,
  ReadyChatArtifact,
} from '../../../types/chatArtifact';
import {
  isChatArtifact,
  isCompleteArtifact,
  isDraftArtifact,
  isInterruptedArtifact,
  isPromotingArtifact,
  isPromotionFailedArtifact,
  isReadyArtifact,
} from '../../../types/chatArtifact';
import type {
  ChatMessage,
  MessagePart,
  StoryArtifactPart,
  StoryCardPart,
} from '../../../types/chat';
import {
  extractTextFromParts,
  isStoryArtifactPart,
  isStoryCardPart,
  isTextPart,
} from '../../../types/chat';
import {
  appendDraftChunk,
  assertArtifactInvariants,
  canInterrupt,
  canPromote,
  canRetryPromotion,
  completeArtifact,
  createDraftArtifact,
  decodeLegacyStoryCard,
  getSourceMessageId,
  interruptArtifact,
  isAllowedTransition,
  isSameSourceArtifact,
  isTerminalArtifact,
  markPromotionFailed,
  markPromotionSuccess,
  retryPromotion,
  startPromotion,
  validateArtifactInvariants,
} from '../../../lib/client/chatArtifactState';

/**
 * M4-01 / E2E-08-01 Artifact Domain Contract 单元测试。
 *
 * 验证：
 * 1. Message delivery 与 Artifact lifecycle 彻底分开。
 * 2. 状态机表达与全生命周期状态跃迁（draft/complete/promoting/ready/promotion_failed/interrupted），Modern Artifact 绝无 audioUrl。
 * 3. 严格不变量约束（draft/interrupted 严禁 storyWorkId；ready 必须包含正整数 storyWorkId；promotion_failed 保留内容）。
 * 4. sourceMessageId 规则冻结（assistant message id 幂等关联）。
 * 5. Legacy StoryCardPart 只读解码与不可 promotion 铁律约束（不产生 StoryWork 新写）。
 * 6. 纯领域契约与零副作用静态架构守卫（无 audioUrl 泄漏、无外部依赖泄漏）。
 */

async function main() {
  console.log('=== 1. Message delivery 与 Artifact lifecycle 解耦断言 ===');
  {
    // Delivery 属于网络/消息通道层（ChatMessageDeliveryStatus: sending | delivered | failed）
    // Artifact lifecycle 属于内容资产层（ChatArtifactStatus: draft | complete | promoting | ready | ...）
    const assistantMsgId = 'msg-assistant-101';
    const draft = createDraftArtifact({
      sourceMessageId: assistantMsgId,
      initialText: '从前有座山，',
    });

    const storyPart: StoryArtifactPart = {
      type: 'storyArtifact',
      artifact: draft,
    };

    const chatMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: draft.storyText,
      parts: [storyPart],
      status: 'sending', // 消息传输层正在 sending
    };

    assert.strictEqual(chatMsg.status, 'sending', 'ChatMessage delivery 状态为 sending');
    assert.strictEqual(draft.status, 'draft', 'ChatArtifact 状态为 draft');
    assert.strictEqual(isStoryArtifactPart(storyPart), true, 'isStoryArtifactPart 识别正确');
    assert.strictEqual(isTextPart(storyPart), false, 'isTextPart 正确排除 storyArtifact');

    // 验证 extractTextFromParts 能提取 storyArtifact 中的 storyText
    const extracted = extractTextFromParts(chatMsg.parts || []);
    assert.strictEqual(extracted, '从前有座山，', 'extractTextFromParts 正确提取 storyArtifact 文本');

    // 消息投递完成（delivered），但 Artifact 仍可继续处于 draft 或推进到 complete
    const deliveredMsg: ChatMessage = {
      ...chatMsg,
      status: 'delivered',
    };
    assert.strictEqual(deliveredMsg.status, 'delivered');
    assert.strictEqual(storyPart.artifact.status, 'draft', '投递状态变化不影响 Artifact 内部状态');

    console.log('PASS: Message delivery 与 Artifact lifecycle 解耦断言通过');
  }

  console.log('=== 2. 状态机全生命周期快乐路径与分支跃迁断言 ===');
  {
    const assistantMsgId = 'msg-asst-200';
    const t0 = '2026-09-12T10:00:00.000Z';
    const t1 = '2026-09-12T10:00:01.000Z';
    const t2 = '2026-09-12T10:00:02.000Z';
    const t3 = '2026-09-12T10:00:03.000Z';
    const t4 = '2026-09-12T10:00:04.000Z';

    // 2.1 创建 draft
    const draft = createDraftArtifact({
      id: 'artifact-test-1',
      sourceMessageId: assistantMsgId,
      initialText: '很久很久以前',
      title: '森林历险记',
      prompt: '写一个森林历险故事',
      voiceId: 'voice-cherry',
      createdAt: t0,
    });

    assert.strictEqual(draft.status, 'draft');
    assert.strictEqual(draft.storyWorkId, undefined);
    assert.strictEqual(draft.sourceMessageId, assistantMsgId);
    assert.strictEqual(draft.storyText, '很久很久以前');
    assert.strictEqual(canInterrupt(draft), true);
    assert.strictEqual(canPromote(draft), false);
    assert.strictEqual(isTerminalArtifact(draft), false);

    // 2.2 追加 chunk
    const draftStreaming = appendDraftChunk(draft, '，有一只聪明的小狐狸。', t1);
    assert.strictEqual(draftStreaming.status, 'draft');
    assert.strictEqual(draftStreaming.storyText, '很久很久以前，有一只聪明的小狐狸。');
    assert.strictEqual(draftStreaming.updatedAt, t1);

    // 2.3 完成文本生成 draft -> complete
    const completed = completeArtifact(draftStreaming, {
      finalStoryText: '很久很久以前，有一只聪明的小狐狸。它帮助了许多森林里的小动物。',
    }, t2);
    assert.strictEqual(completed.status, 'complete');
    assert.strictEqual(completed.storyWorkId, undefined);
    assert.strictEqual(completed.storyText, '很久很久以前，有一只聪明的小狐狸。它帮助了许多森林里的小动物。');
    assert.strictEqual(canPromote(completed), true);
    assert.strictEqual(canRetryPromotion(completed), false);
    assert.strictEqual(canInterrupt(completed), false);

    // 2.4 开始入库 complete -> promoting
    const promoting = startPromotion(completed, t3);
    assert.strictEqual(promoting.status, 'promoting');
    assert.strictEqual(promoting.storyWorkId, undefined);
    assert.strictEqual(promoting.sourceMessageId, assistantMsgId);
    assert.strictEqual(promoting.storyText, completed.storyText);
    assert.strictEqual(canPromote(promoting), false);

    // 2.5 入库成功 promoting -> ready（Modern Artifact 绝无 audioUrl）
    const ready = markPromotionSuccess(promoting, {
      storyWorkId: 789,
    }, t4);
    assert.strictEqual(ready.status, 'ready');
    assert.strictEqual(ready.storyWorkId, 789);
    assert.strictEqual('audioUrl' in ready, false, 'Modern Ready Artifact 绝不包含 audioUrl');
    assert.strictEqual(isTerminalArtifact(ready), true);
    assert.strictEqual(canPromote(ready), false);

    console.log('PASS: 快乐路径（draft -> complete -> promoting -> ready）断言通过');
  }

  console.log('=== 3. 失败重试路径（promoting -> promotion_failed -> retry -> ready）断言 ===');
  {
    const assistantMsgId = 'msg-asst-300';
    const draft = createDraftArtifact({
      sourceMessageId: assistantMsgId,
      initialText: '海底两万里探索',
    });
    const completed = completeArtifact(draft);
    const promoting = startPromotion(completed);

    // 入库失败
    const failed = markPromotionFailed(promoting, {
      error: '网络超时：连接 library.create 失败',
    });
    assert.strictEqual(failed.status, 'promotion_failed');
    assert.strictEqual(failed.storyWorkId, undefined);
    assert.strictEqual(failed.error, '网络超时：连接 library.create 失败');
    // 关键契约：保留内容与 sourceMessageId，支持幂等重试无需重新生成
    assert.strictEqual(failed.storyText, completed.storyText);
    assert.strictEqual(failed.sourceMessageId, assistantMsgId);
    assert.strictEqual(canPromote(failed), true);
    assert.strictEqual(canRetryPromotion(failed), true);

    // 重试入库
    const retrying = retryPromotion(failed);
    assert.strictEqual(retrying.status, 'promoting');
    assert.strictEqual(retrying.storyWorkId, undefined);
    assert.strictEqual(retrying.sourceMessageId, assistantMsgId);
    assert.strictEqual(retrying.storyText, completed.storyText);

    // 重试后入库成功
    const ready = markPromotionSuccess(retrying, { storyWorkId: 1001 });
    assert.strictEqual(ready.status, 'ready');
    assert.strictEqual(ready.storyWorkId, 1001);
    assert.strictEqual(ready.sourceMessageId, assistantMsgId);

    console.log('PASS: 失败重试路径断言通过');
  }

  console.log('=== 4. 中断路径（draft -> interrupted）断言 ===');
  {
    const assistantMsgId = 'msg-asst-400';
    const draft = createDraftArtifact({
      sourceMessageId: assistantMsgId,
      initialText: '正在生成中的草稿...',
    });

    const interrupted = interruptArtifact(draft, { reason: '用户主动取消' });
    assert.strictEqual(interrupted.status, 'interrupted');
    assert.strictEqual(interrupted.storyWorkId, undefined);
    assert.strictEqual(interrupted.reason, '用户主动取消');
    assert.strictEqual(isTerminalArtifact(interrupted), true);
    assert.strictEqual(canPromote(interrupted), false);
    assert.strictEqual(canInterrupt(interrupted), false);

    console.log('PASS: 中断路径断言通过');
  }

  console.log('=== 5. 非法状态跃迁全矩阵拒绝断言 ===');
  {
    const assistantMsgId = 'msg-asst-500';
    const draft = createDraftArtifact({
      sourceMessageId: assistantMsgId,
      initialText: '内容正文',
    });
    const completed = completeArtifact(draft);
    const promoting = startPromotion(completed);
    const ready = markPromotionSuccess(promoting, { storyWorkId: 88 });
    const failed = markPromotionFailed(startPromotion(completeArtifact(createDraftArtifact({ sourceMessageId: 'msg-f', initialText: 'text' }))));
    const interrupted = interruptArtifact(createDraftArtifact({ sourceMessageId: 'msg-i', initialText: 'text' }));

    // 状态转移表断言
    assert.strictEqual(isAllowedTransition('draft', 'complete'), true);
    assert.strictEqual(isAllowedTransition('draft', 'interrupted'), true);
    assert.strictEqual(isAllowedTransition('draft', 'promoting'), false);
    assert.strictEqual(isAllowedTransition('draft', 'ready'), false);
    assert.strictEqual(isAllowedTransition('draft', 'promotion_failed'), false);

    assert.strictEqual(isAllowedTransition('complete', 'promoting'), true);
    assert.strictEqual(isAllowedTransition('complete', 'ready'), false);
    assert.strictEqual(isAllowedTransition('complete', 'draft'), false);
    assert.strictEqual(isAllowedTransition('complete', 'interrupted'), false);

    assert.strictEqual(isAllowedTransition('promoting', 'ready'), true);
    assert.strictEqual(isAllowedTransition('promoting', 'promotion_failed'), true);
    assert.strictEqual(isAllowedTransition('promoting', 'draft'), false);
    assert.strictEqual(isAllowedTransition('promoting', 'complete'), false);

    assert.strictEqual(isAllowedTransition('ready', 'draft'), false);
    assert.strictEqual(isAllowedTransition('ready', 'promoting'), false);
    assert.strictEqual(isAllowedTransition('ready', 'complete'), false);
    assert.strictEqual(isAllowedTransition('ready', 'promotion_failed'), false);

    assert.strictEqual(isAllowedTransition('promotion_failed', 'promoting'), true);
    assert.strictEqual(isAllowedTransition('promotion_failed', 'ready'), false);
    assert.strictEqual(isAllowedTransition('promotion_failed', 'complete'), false);

    assert.strictEqual(isAllowedTransition('interrupted', 'draft'), false);
    assert.strictEqual(isAllowedTransition('interrupted', 'promoting'), false);
    assert.strictEqual(isAllowedTransition('interrupted', 'ready'), false);

    // 函数执行调用拒绝
    assert.throws(
      () => startPromotion(draft as unknown as CompleteChatArtifact),
      /非法状态转移.*draft.*promoting/
    );
    assert.throws(
      () => markPromotionSuccess(completed as unknown as PromotingChatArtifact, { storyWorkId: 1 }),
      /非法状态转移.*complete.*ready/
    );
    assert.throws(
      () => completeArtifact(ready as unknown as DraftChatArtifact),
      /非法状态转移.*ready.*complete/
    );
    assert.throws(
      () => interruptArtifact(completed as unknown as DraftChatArtifact),
      /非法状态转移.*complete.*interrupted/
    );

    console.log('PASS: 非法状态跃迁全矩阵拒绝断言通过');
  }

  console.log('=== 6. 状态约束与不变量严格契约断言 ===');
  {
    const assistantMsgId = 'msg-asst-600';

    // 6.1 draft 绝不能有 StoryWork
    const draftInvalid = {
      id: 'art-draft-invalid',
      artifactType: 'story',
      status: 'draft',
      sourceMessageId: assistantMsgId,
      storyText: 'drafting...',
      storyWorkId: 123, // 违规
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const vDraft = validateArtifactInvariants(draftInvalid);
    assert.strictEqual(vDraft.valid, false);
    assert.ok(vDraft.errors.some((e) => e.includes('严禁包含 storyWorkId')));
    assert.throws(() => assertArtifactInvariants(draftInvalid), /严禁包含 storyWorkId/);

    // 6.2 interrupted 绝不能有 StoryWork
    const interruptedInvalid = {
      id: 'art-int-invalid',
      artifactType: 'story',
      status: 'interrupted',
      sourceMessageId: assistantMsgId,
      storyText: 'cancelled',
      storyWorkId: 456, // 违规
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const vInt = validateArtifactInvariants(interruptedInvalid);
    assert.strictEqual(vInt.valid, false);
    assert.ok(vInt.errors.some((e) => e.includes('严禁包含 storyWorkId')));

    // 6.3 complete 资产尚未创建，storyWorkId 必须为 undefined
    const completeInvalid = {
      id: 'art-comp-invalid',
      artifactType: 'story',
      status: 'complete',
      sourceMessageId: assistantMsgId,
      storyText: 'full story text',
      storyWorkId: 789, // 违规
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const vComp = validateArtifactInvariants(completeInvalid);
    assert.strictEqual(vComp.valid, false);
    assert.ok(vComp.errors.some((e) => e.includes('storyWorkId 必须为 undefined')));

    // 6.4 complete 故事文本不能为空
    const completeEmptyText = {
      id: 'art-comp-empty',
      artifactType: 'story',
      status: 'complete',
      sourceMessageId: assistantMsgId,
      storyText: '   ',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const vCompEmpty = validateArtifactInvariants(completeEmptyText);
    assert.strictEqual(vCompEmpty.valid, false);
    assert.ok(vCompEmpty.errors.some((e) => e.includes('故事文本不得为空')));

    // 6.5 ready 必须有合法正整数 storyWorkId
    const testCases: { idValue: unknown; desc: string }[] = [
      { idValue: undefined, desc: 'undefined' },
      { idValue: 0, desc: '0' },
      { idValue: -5, desc: '-5' },
      { idValue: 3.1415, desc: '浮点数' },
      { idValue: NaN, desc: 'NaN' },
      { idValue: '123', desc: '字符串' },
      { idValue: null, desc: 'null' },
    ];

    for (const tc of testCases) {
      const readyInvalid = {
        id: 'art-ready-invalid',
        artifactType: 'story',
        status: 'ready',
        sourceMessageId: assistantMsgId,
        storyText: 'story text',
        storyWorkId: tc.idValue,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const vReady = validateArtifactInvariants(readyInvalid);
      assert.strictEqual(vReady.valid, false, `ready 含 ${tc.desc} 必须校验失败`);
      assert.ok(
        vReady.errors.some((e) => e.includes('合法正整数 storyWorkId')),
        `ready 含 ${tc.desc} 必须报错正整数校验`
      );
    }

    // 正整数通过
    const readyValid = {
      id: 'art-ready-valid',
      artifactType: 'story',
      status: 'ready',
      sourceMessageId: assistantMsgId,
      storyText: 'story text',
      storyWorkId: 42,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const vReadyOk = validateArtifactInvariants(readyValid);
    assert.strictEqual(vReadyOk.valid, true);

    console.log('PASS: 状态约束与不变量严格契约断言通过');
  }

  console.log('=== 7. sourceMessageId 规则冻结与幂等契约断言 ===');
  {
    // sourceMessageId 必须非空且严格等于产生该 Artifact 的 assistant 消息 id
    assert.throws(
      () => createDraftArtifact({ sourceMessageId: '', initialText: 'test' }),
      /必须提供非空 sourceMessageId/
    );
    assert.throws(
      () => createDraftArtifact({ sourceMessageId: '   ', initialText: 'test' }),
      /必须提供非空 sourceMessageId/
    );

    const asstId = 'assistant-msg-canonical-777';
    const draft = createDraftArtifact({
      sourceMessageId: asstId,
      initialText: '故事第一句。',
    });
    assert.strictEqual(getSourceMessageId(draft), asstId);

    const completed = completeArtifact(draft);
    assert.strictEqual(getSourceMessageId(completed), asstId);

    const promoting = startPromotion(completed);
    assert.strictEqual(getSourceMessageId(promoting), asstId);

    // 模拟 library.create 响应丢失，promotion 失败
    const failed = markPromotionFailed(promoting, { error: 'Network timeout / 504' });
    assert.strictEqual(getSourceMessageId(failed), asstId);
    assert.strictEqual(failed.storyText, completed.storyText);

    // 模拟重试 promotion：传入同一个 assistantMessageId + storyText
    const retried = retryPromotion(failed);
    assert.strictEqual(getSourceMessageId(retried), asstId);
    assert.strictEqual(isSameSourceArtifact(completed, retried), true);

    // 与另一个消息产生的 Artifact 比较
    const otherArtifact = createDraftArtifact({
      sourceMessageId: 'assistant-msg-other-999',
      initialText: '另一个故事',
    });
    assert.strictEqual(isSameSourceArtifact(draft, otherArtifact), false);

    console.log('PASS: sourceMessageId 规则冻结与幂等契约断言通过');
  }

  console.log('=== 8. Legacy StoryCardPart 只读解码与不可 Promotion 铁律断言（B2） ===');
  {
    const legacyCard: StoryCardPart = {
      type: 'storyCard',
      storyText: '这是 Legacy 阶段生成的故事正文。从前有一只住在云朵里的小羊。',
      audioUrl: 'blob:http://localhost:3000/mock-audio-blob-123',
    };

    // 8.1 规范解码：正常返回规范化的 StoryCardPart
    const decoded = decodeLegacyStoryCard(legacyCard);
    assert.ok(decoded !== null, 'decodeLegacyStoryCard 解码成功');
    assert.strictEqual(decoded.type, 'storyCard');
    assert.strictEqual(decoded.storyText, legacyCard.storyText);
    assert.strictEqual(decoded.audioUrl, legacyCard.audioUrl);

    // 8.2 核心冻结语义（B2 铁律）：Legacy 卡片只读兼容，绝非现代 ChatArtifact
    assert.strictEqual(isChatArtifact(decoded), false, 'StoryCardPart 绝非 ChatArtifact');
    assert.strictEqual(isCompleteArtifact(decoded as unknown as ChatArtifact), false);
    assert.strictEqual(isDraftArtifact(decoded as unknown as ChatArtifact), false);
    assert.strictEqual(isReadyArtifact(decoded as unknown as ChatArtifact), false);
    assert.strictEqual(canPromote(decoded as unknown as ChatArtifact), false, 'Legacy 卡片绝对不可发起 promotion');

    // 8.3 严禁将 Legacy 卡片作为 CompleteChatArtifact 传入 startPromotion（运行时抛错阻断）
    assert.throws(
      () => startPromotion(decoded as unknown as CompleteChatArtifact),
      /非法状态转移/
    );

    // 8.4 异常 Legacy 输入安全返回 null
    assert.strictEqual(decodeLegacyStoryCard(null), null);
    assert.strictEqual(decodeLegacyStoryCard({}), null);
    assert.strictEqual(decodeLegacyStoryCard({ type: 'text', content: 'hello' }), null);
    assert.strictEqual(decodeLegacyStoryCard({ type: 'storyCard', storyText: '  ', audioUrl: 'url' }), null);
    assert.strictEqual(decodeLegacyStoryCard({ type: 'storyCard', storyText: 'story' }), null); // 缺失 audioUrl

    console.log('PASS: Legacy StoryCardPart 只读解码与不可 Promotion 铁律断言通过');
  }

  console.log('=== 9. 纯函数与类型守卫完整性断言 ===');
  {
    const asstId = 'msg-typeguard-999';
    const draft = createDraftArtifact({ sourceMessageId: asstId, initialText: 'a' });
    const completed = completeArtifact(draft);
    const promoting = startPromotion(completed);
    const ready = markPromotionSuccess(promoting, { storyWorkId: 10 });
    const failed = markPromotionFailed(startPromotion(completeArtifact(createDraftArtifact({ sourceMessageId: asstId, initialText: 'b' }))));
    const interrupted = interruptArtifact(createDraftArtifact({ sourceMessageId: asstId, initialText: 'c' }));

    assert.strictEqual(isDraftArtifact(draft), true);
    assert.strictEqual(isDraftArtifact(completed), false);

    assert.strictEqual(isCompleteArtifact(completed), true);
    assert.strictEqual(isCompleteArtifact(draft), false);

    assert.strictEqual(isPromotingArtifact(promoting), true);
    assert.strictEqual(isPromotingArtifact(ready), false);

    assert.strictEqual(isReadyArtifact(ready), true);
    assert.strictEqual(isReadyArtifact(promoting), false);

    assert.strictEqual(isPromotionFailedArtifact(failed), true);
    assert.strictEqual(isPromotionFailedArtifact(completed), false);

    assert.strictEqual(isInterruptedArtifact(interrupted), true);
    assert.strictEqual(isInterruptedArtifact(draft), false);

    assert.strictEqual(isChatArtifact(draft), true);
    assert.strictEqual(isChatArtifact(completed), true);
    assert.strictEqual(isChatArtifact(promoting), true);
    assert.strictEqual(isChatArtifact(ready), true);
    assert.strictEqual(isChatArtifact(failed), true);
    assert.strictEqual(isChatArtifact(interrupted), true);

    // 非法对象拒绝
    assert.strictEqual(isChatArtifact(null), false);
    assert.strictEqual(isChatArtifact({}), false);
    assert.strictEqual(isChatArtifact({ artifactType: 'other' }), false);
    assert.strictEqual(isChatArtifact({ artifactType: 'story', status: 'unknown' }), false);

    console.log('PASS: 类型守卫完整性断言通过');
  }

  console.log('=== 10. 静态架构规范守卫断言（零数据库/网络/React泄漏）===');
  {
    const stateFilePath = path.resolve(__dirname, '../../../lib/client/chatArtifactState.ts');
    const typeFilePath = path.resolve(__dirname, '../../../types/chatArtifact.ts');

    const stateContent = fs.readFileSync(stateFilePath, 'utf8');
    const typeContent = fs.readFileSync(typeFilePath, 'utf8');

    const FORBIDDEN_PATTERNS = [
      /from\s+['"].*lib\/db['"]/,
      /from\s+['"].*prisma['"]/,
      /from\s+['"]react['"]/,
      /from\s+['"]next\//,
      /fetch\s*\(/,
      /trpc\./i,
    ];

    for (const pattern of FORBIDDEN_PATTERNS) {
      assert.strictEqual(
        pattern.test(stateContent),
        false,
        `lib/client/chatArtifactState.ts 违规匹配禁止模式：${pattern}`
      );
      assert.strictEqual(
        pattern.test(typeContent),
        false,
        `types/chatArtifact.ts 违规匹配禁止模式：${pattern}`
      );
    }

    // B1 静态 regression 1：types/chatArtifact.ts 绝不得出现 audioUrl
    assert.strictEqual(
      typeContent.includes('audioUrl'),
      false,
      'types/chatArtifact.ts 静态违规：绝不得出现 audioUrl'
    );

    // B1 静态 regression 2：chatArtifactState.ts 的现代状态转换函数绝不接受/传播 audioUrl
    const legacySplitIdx = stateContent.indexOf('decodeLegacyStoryCard');
    assert.ok(legacySplitIdx > 0, 'chatArtifactState.ts 必须包含 decodeLegacyStoryCard 分界');
    const modernStateContent = stateContent.slice(0, legacySplitIdx);
    assert.strictEqual(
      modernStateContent.includes('audioUrl'),
      false,
      'chatArtifactState.ts 现代状态转换静态违规：不得接受或传播 audioUrl'
    );

    // B1 静态 regression 3：types/chat.ts 中的 Legacy StoryCardPart 仍必须保留 audioUrl（旧数据向后兼容）
    const chatTypesPath = path.resolve(__dirname, '../../../types/chat.ts');
    const chatTypesContent = fs.readFileSync(chatTypesPath, 'utf8');
    assert.ok(
      chatTypesContent.includes('audioUrl: string'),
      'types/chat.ts 静态回归：StoryCardPart 必须保留 audioUrl: string'
    );

    console.log('PASS: 静态架构规范守卫断言通过（无数据库/网络/React依赖泄漏，Modern 无 audioUrl，Legacy 保留 audioUrl）');
  }

  console.log('\nALL STORY ARTIFACT CONTRACT UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = main()
  .then(() => {
    console.log('ALL STORY ARTIFACT CONTRACT UNIT TESTS PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('TEST FAILED:', err);
    process.exit(1);
  });

export default testPromise;
