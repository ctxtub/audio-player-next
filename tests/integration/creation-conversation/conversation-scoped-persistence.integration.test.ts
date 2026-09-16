/**
 * 会话级持久化 + promotion 唯一写路径集成测试（L2，M9-C1 T2 评审闭合项 1/2）。
 *
 * 行为 RED（在基线 cdbf5d37 上因旧行为仍成立而失败，不是 Cannot find module）：
 * 1. Chat 读路径：chatStore.initForUser 必须按当前 conversationId 调
 *    `conversation.fetchConversationMessages(id)` 读取；基线仍走 subject 级
 *    `chatConversation.fetchMyConversation`（返回另一份消息）→ 断言失败。
 * 2. Chat 写路径：flushPendingSave 必须按当前 conversationId 调
 *    `conversation.saveConversationSnapshot(id, ...)`；基线仍走
 *    `chatConversation.saveMyConversation` → 断言失败。
 * 3. Promotion 唯一写路径：真实 `promoteStoryArtifact` 缺省必须落
 *    `collection.promoteArtifact` 并携带 conversationId；基线走
 *    `library.create` → 断言失败（且 library 旁路调用次数 > 0）。
 * 4. 编排层 `executePromotionCreate` 经真实 adapter（无 override）同样落
 *    collection.promoteArtifact，证明只有一条写路径。
 *
 * 边界：只桩网络门面（chatConversation/conversation/collection/library），
 * store、orchestration、adapter、状态机均走真实实现；不建 socket、不碰真库。
 */

import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const cwd = process.cwd();

// ---- GlassToast 桩（jiti 不能在 Node 侧解析 .tsx，chatStore/configStore 间接依赖）----
const glassToastPath = path.resolve(cwd, 'components/ui/GlassToast.tsx');
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

const ACTIVE_CONVERSATION = {
  id: 'conv-A',
  state: 'active',
  collectionId: 'col-A',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
};

const convMsg: DtoLike = {
  messageId: 'conv-msg-1',
  role: 'assistant',
  content: '会话级消息',
  createdAt: '2026-09-15T00:00:01.000Z',
};
const legacyMsg: DtoLike = {
  messageId: 'legacy-msg-1',
  role: 'assistant',
  content: '主体级遗留消息',
  createdAt: '2026-09-15T00:00:02.000Z',
};

const legacyFetchCalls: string[] = [];
const legacySaveCalls: DtoLike[][] = [];
const conversationFetchCalls: string[] = [];
const conversationSaveCalls: Array<{ conversationId: string; messages: DtoLike[]; base?: string[] }> = [];
const promoteCalls: Array<Record<string, unknown>> = [];
const libraryCreateCalls: Array<Record<string, unknown>> = [];

// ---- legacy subject 级写路径桩（基线会用，T2 后不得再被读/写路径命中）----
const chatConversationPath = path.resolve(cwd, 'lib/client/chatConversation.ts');
nodeRequire.cache[chatConversationPath] = {
  id: chatConversationPath,
  filename: chatConversationPath,
  loaded: true,
  exports: {
    fetchMyConversation: async () => {
      legacyFetchCalls.push('fetchMyConversation');
      return [legacyMsg];
    },
    saveMyConversation: async (messages: DtoLike[]) => {
      legacySaveCalls.push(messages);
      return { ok: true };
    },
  },
} as unknown as NodeModule;

// ---- 会话级门面桩（T2 读/写路径唯一入口）----
const conversationClientPath = path.resolve(cwd, 'lib/client/conversation.ts');
nodeRequire.cache[conversationClientPath] = {
  id: conversationClientPath,
  filename: conversationClientPath,
  loaded: true,
  exports: {
    getActiveConversation: async () => ACTIVE_CONVERSATION,
    ensureActiveConversation: async () => ACTIVE_CONVERSATION,
    getConversation: async () => ACTIVE_CONVERSATION,
    createNewConversation: async () => ({ ...ACTIVE_CONVERSATION, id: 'conv-B' }),
    closeConversation: async () => ACTIVE_CONVERSATION,
    fetchConversationMessages: async (conversationId: string) => {
      conversationFetchCalls.push(conversationId);
      return [{ ...convMsg }];
    },
    saveConversationSnapshot: async (
      conversationId: string,
      messages: DtoLike[],
      baseMessageIds?: string[],
    ) => {
      conversationSaveCalls.push({ conversationId, messages, base: baseMessageIds });
      return { ok: true };
    },
  },
} as unknown as NodeModule;

// ---- collection 唯一写入口桩（promotion 必须落这里）----
const collectionClientPath = path.resolve(cwd, 'lib/client/collection.ts');
nodeRequire.cache[collectionClientPath] = {
  id: collectionClientPath,
  filename: collectionClientPath,
  loaded: true,
  exports: {
    promoteArtifact: async (input: Record<string, unknown>) => {
      promoteCalls.push(input);
      return {
        id: 9001,
        title: '会话级作品',
        excerpt: '',
        voiceId: 'voice-A',
        contentHash: 'hash-A',
        favoritedAt: null,
        deletedAt: null,
        createdAt: '2026-09-15T00:00:03.000Z',
        updatedAt: '2026-09-15T00:00:03.000Z',
        audio: { status: 'missing', durationMs: null },
        prompt: input.prompt,
        storyText: input.storyText,
        sourceMessageId: input.sourceMessageId,
      };
    },
    listCollections: async () => ({ items: [], nextCursor: null }),
    getCollection: async () => null,
    renameCollection: async () => null,
    setCollectionFavorite: async () => null,
    softDeleteCollection: async () => null,
    restoreCollection: async () => null,
    deleteCollectionForever: async () => null,
  },
} as unknown as NodeModule;

// ---- library 旁路桩（若 promotion 仍走 library.create，这里会被命中并让断言失败）----
const libraryClientPath = path.resolve(cwd, 'lib/client/library.ts');
nodeRequire.cache[libraryClientPath] = {
  id: libraryClientPath,
  filename: libraryClientPath,
  loaded: true,
  exports: {
    libraryClient: {
      create: async (input: Record<string, unknown>) => {
        libraryCreateCalls.push(input);
        return { id: 1, title: '', excerpt: '' };
      },
    },
    create: async (input: Record<string, unknown>) => {
      libraryCreateCalls.push(input);
      return { id: 1, title: '', excerpt: '' };
    },
    get: async () => null,
    list: async () => ({ items: [], nextCursor: null }),
  },
} as unknown as NodeModule;

const { useChatStore } = nodeRequire('../../../stores/chatStore') as typeof import('../../../stores/chatStore');
const { createDraftArtifact, completeArtifact } = nodeRequire(
  '../../../lib/client/chatArtifactState',
) as typeof import('../../../lib/client/chatArtifactState');
const { promoteStoryArtifact } = nodeRequire(
  '../../../lib/client/storyArtifactPromotion',
) as typeof import('../../../lib/client/storyArtifactPromotion');
const { executePromotionCreate, setPromotionCreateOverride } = nodeRequire(
  '../../../lib/client/chatPromotionOrchestration',
) as typeof import('../../../lib/client/chatPromotionOrchestration');

function resetCounters(): void {
  legacyFetchCalls.length = 0;
  legacySaveCalls.length = 0;
  conversationFetchCalls.length = 0;
  conversationSaveCalls.length = 0;
  promoteCalls.length = 0;
  libraryCreateCalls.length = 0;
}

function resetStore(): void {
  useChatStore.getState().reset();
  useChatStore.setState({
    syncEnabled: false,
    conversationId: 'conv-A',
    collectionId: 'col-A',
    collectionTitle: '集合 A',
  });
}

function buildCompleteArtifact() {
  const draft = createDraftArtifact({
    sourceMessageId: 'assistant-scope-1',
    initialText: '深海之下，小潜航员点亮了灯。',
    prompt: '给五岁的孩子讲一个深海小潜航员的故事',
    voiceId: 'voice-A',
  });
  return completeArtifact(draft, { finalStoryText: '深海之下，小潜航员点亮了灯。' });
}

async function runTests(): Promise<void> {
  console.log('=== SCOPE-01: 读路径必须按当前 conversationId 会话级读取 ===');
  {
    resetCounters();
    resetStore();
    await useChatStore.getState().initForUser();
    assert.deepStrictEqual(conversationFetchCalls, ['conv-A'], 'initForUser 必须按 conversationId 读取');
    assert.strictEqual(legacyFetchCalls.length, 0, '读路径不得再走 subject 级 fetchMyConversation');
    assert.ok(
      useChatStore.getState().messages.some((m) => m.id === convMsg.messageId),
      '必须恢复会话级消息',
    );
    assert.ok(
      !useChatStore.getState().messages.some((m) => m.id === legacyMsg.messageId),
      '不得恢复主体级遗留消息',
    );
    console.log('PASS: SCOPE-01 conversation-scoped read');
  }

  console.log('=== SCOPE-02: 写路径必须按当前 conversationId 会话级落库 ===');
  {
    resetCounters();
    resetStore();
    useChatStore.setState({ syncEnabled: true, conversationId: 'conv-A' });
    const now = new Date().toISOString();
    useChatStore.setState({
      messages: [
        { id: 'scope-user-1', role: 'user', content: '会话级写入', status: 'delivered', createdAt: now },
        { id: 'scope-assistant-1', role: 'assistant', content: '会话级回答', status: 'delivered', createdAt: now },
      ] as never,
    });
    const flushed = await useChatStore.getState().flushPendingSave();
    assert.strictEqual(flushed, true, 'flush 应成功');
    assert.strictEqual(conversationSaveCalls.length, 1, '必须恰好一次会话级保存');
    assert.strictEqual(conversationSaveCalls[0].conversationId, 'conv-A', '保存必须携带当前 conversationId');
    assert.ok(
      conversationSaveCalls[0].messages.some((m) => m.content === '会话级回答'),
      '快照必须包含会话级尾部',
    );
    assert.strictEqual(legacySaveCalls.length, 0, '写路径不得再走 subject 级 saveMyConversation');
    console.log('PASS: SCOPE-02 conversation-scoped write');
  }

  console.log('=== SCOPE-03: promotion 唯一写路径落 collection.promoteArtifact 并携带 conversationId ===');
  {
    resetCounters();
    const artifact = buildCompleteArtifact();
    const dto = await promoteStoryArtifact(artifact, { conversationId: 'conv-A' });
    assert.strictEqual(dto.id, 9001);
    assert.strictEqual(promoteCalls.length, 1, '必须恰好一次 collection.promoteArtifact');
    assert.strictEqual(promoteCalls[0].conversationId, 'conv-A', 'promotion 必须携带当前 conversationId');
    assert.strictEqual(promoteCalls[0].prompt, artifact.prompt, 'prompt 取冻结快照');
    assert.strictEqual(promoteCalls[0].storyText, artifact.storyText);
    assert.strictEqual(promoteCalls[0].voiceId, artifact.voiceId);
    assert.strictEqual(promoteCalls[0].sourceMessageId, artifact.sourceMessageId);
    assert.strictEqual(promoteCalls[0].title, undefined, '不得自行补 title');
    assert.strictEqual(libraryCreateCalls.length, 0, 'promotion 不得再有 library.create 旁路');
    console.log('PASS: SCOPE-03 collection.promoteArtifact with conversationId');
  }

  console.log('=== SCOPE-04: 编排层经真实 adapter 仍只有一条写路径 ===');
  {
    resetCounters();
    setPromotionCreateOverride(undefined);
    const artifact = buildCompleteArtifact();
    await executePromotionCreate(artifact, 'conv-A');
    assert.strictEqual(promoteCalls.length, 1, 'orchestration→adapter→collection 必须一条路径');
    assert.strictEqual(promoteCalls[0].conversationId, 'conv-A');
    assert.strictEqual(libraryCreateCalls.length, 0, '编排不得触达 library 旁路');
    console.log('PASS: SCOPE-04 orchestration single write path');
  }

  console.log('=== SCOPE-05: 缺 conversationId 必须 fail-fast（不静默落旧路径）===');
  {
    resetCounters();
    const artifact = buildCompleteArtifact();
    await assert.rejects(
      () => promoteStoryArtifact(artifact, { conversationId: undefined }),
      /conversationId/,
      '缺 conversationId 必须 fail-fast',
    );
    assert.strictEqual(promoteCalls.length, 0, 'fail-fast 不得触达 collection');
    assert.strictEqual(libraryCreateCalls.length, 0, 'fail-fast 不得回落 library');
    console.log('PASS: SCOPE-05 fail-fast without conversationId');
  }

  useChatStore.getState().reset();
  setPromotionCreateOverride(undefined);
  console.log('ALL CONVERSATION SCOPED PERSISTENCE TESTS PASSED SUCCESSFULLY');
}

const testPromise = runTests()
  .then(() => {
    console.log('ALL CONVERSATION SCOPED PERSISTENCE TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
