import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TRPCError } from '@/lib/trpc/init';
import {
  createToastCapture,
  installGlassToastStub,
} from '../../support/mocks/ui-state.mock';
import { makeGuestId, makeMessageId } from '../../support/builders/auth-subject.builder';
import { setupIsolatedDb } from '../../support/db/isolated-db.helper';
import {
  SEGMENTATION_VERSION,
  computeStoryContentHash,
  normalizeStoryText,
  segmentStoryText,
} from '../../../utils/segmentation';
import { REPLAY_TEXT_PREFIX, isValidDraftMessageId } from '../../../lib/playback/source';
import type { Subject } from '../../../lib/server/subject';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const toastCapture = createToastCapture();
installGlassToastStub(toastCapture);

/**
 * M9-F01 StoryCard / Generation History 播放入口集成测试（L2，真隔离库 + 真 server）。
 *
 * 覆盖 spec §"状态迁移 oracle A–E"：
 * - A：Legacy storyCard（含 persisted audioUrl）经 Flow.playStoryCard → 真 server
 *      begin（draft snapshot）→ 真 hydrate → 起播时已有正式 Session；
 *      legacy audioUrl 不进入播放（无 segment identity，绝不 duplicate-play）；
 * - B：`replay-text-*` 瞬态 id 一律 fail-closed（不 begin、不落 Anchor）；
 * - C：server begin 门 —— 同 source + 新 UUID + resume → BAD_REQUEST；
 *      同 sessionId + restart → BAD_REQUEST（新会话必须新 UUID）；
 * - D：切换 Work（History 回放 A→B）→ 两次真 server begin，最终归属最后一次操作；
 * - E：同 Work 正在出声 → 正式 pause；断点位 resume → sessionId 不变、只合成断点段。
 *
 * client 层（tts/library/storyAudio/chatConversation/playbackSession）全部经
 * require 缓存桩接到真 server，只去掉网络，不断言网络行为。全程受控隔离库
 * （runner 注入 DATABASE_URL），不碰 dev.db/app.db。
 */

const subjectRef: { current: Subject | null } = { current: null };

function requireSubject(): Subject {
  if (!subjectRef.current) {
    throw new Error('测试错误：subjectRef 未设置，禁止跨用例串用 Session');
  }
  return subjectRef.current;
}

// —— client 桩：playbackSession → 真 server（subject 绑定） ——
const playbackSessionClientPath = path.resolve(process.cwd(), 'lib/client/playbackSession.ts');
nodeRequire.cache[playbackSessionClientPath] = {
  id: playbackSessionClientPath,
  filename: playbackSessionClientPath,
  loaded: true,
  exports: {
    getPlaybackAnchor: async () => {
      const { getPlaybackAnchorForSubject } = await import('../../../lib/server/playbackSession');
      return getPlaybackAnchorForSubject(requireSubject());
    },
    beginPlaybackSession: async (input: unknown) => {
      const { beginPlaybackSessionForSubject } = await import('../../../lib/server/playbackSession');
      return beginPlaybackSessionForSubject(requireSubject(), input as never);
    },
    savePlaybackCheckpoint: async (input: unknown) => {
      const { savePlaybackCheckpointForSubject } = await import('../../../lib/server/playbackSession');
      return savePlaybackCheckpointForSubject(requireSubject(), input as never);
    },
    completePlaybackSession: async (input: unknown) => {
      const { completePlaybackSessionForSubject } = await import('../../../lib/server/playbackSession');
      return completePlaybackSessionForSubject(requireSubject(), input as never);
    },
    clearPlaybackAnchor: async (input: unknown) => {
      const { clearPlaybackAnchorForSubject } = await import('../../../lib/server/playbackSession');
      return clearPlaybackAnchorForSubject(requireSubject(), input as never);
    },
    promoteDraftPlaybackToWork: async (input: unknown) => {
      const { promoteDraftPlaybackToWorkForSubject } = await import('../../../lib/server/playbackSession');
      return promoteDraftPlaybackToWorkForSubject(requireSubject(), input as never);
    },
    getWorkPlaybackProgressBatch: async (input: unknown) => {
      const { getWorkPlaybackProgressBatchForSubject } = await import('../../../lib/server/playbackSession');
      return getWorkPlaybackProgressBatchForSubject(requireSubject(), input as never);
    },
    setSleepTimer: async (input: unknown) => {
      const { setSleepTimerForSubject } = await import('../../../lib/server/playbackSession');
      return setSleepTimerForSubject(requireSubject(), input as never);
    },
  },
} as unknown as NodeModule;

// —— client 桩：library.get → 真 server Work 精确 resolve ——
const libraryPath = path.resolve(process.cwd(), 'lib/client/library.ts');
nodeRequire.cache[libraryPath] = {
  id: libraryPath,
  filename: libraryPath,
  loaded: true,
  exports: {
    get: async (input: { id: number }) => {
      const { getStoryWorkForSubject } = await import('../../../lib/server/storyWork');
      return getStoryWorkForSubject(requireSubject(), input.id);
    },
  },
} as unknown as NodeModule;

// —— client 桩：storyAudio —— canonical 关闭 + 无 Manifest（回落本地切分/P0 provider） ——
const storyAudioPath = path.resolve(process.cwd(), 'lib/client/storyAudio.ts');
nodeRequire.cache[storyAudioPath] = {
  id: storyAudioPath,
  filename: storyAudioPath,
  loaded: true,
  exports: {
    getPlaybackManifest: async () => null,
    ensureSegment: async () => {
      throw new Error('M9F01_L2: canonical ensureSegment 不应被调用（flag off）');
    },
    shouldUseCanonicalAudio: () => false,
    isCanonicalPlaybackUrl: () => false,
    selectWorkParagraphs: (
      localParagraphs: string[],
      manifest: { segments?: Array<{ text: string }> } | null,
    ) =>
      manifest && Array.isArray(manifest.segments) && manifest.segments.length > 0
        ? manifest.segments.map((segment) => segment.text)
        : localParagraphs,
  },
} as unknown as NodeModule;

// —— client 桩：tts provider（记录入参；不触网络） ——
const ttsInputs: string[] = [];
const ttsPath = path.resolve(process.cwd(), 'lib/client/ttsGenerate.ts');
nodeRequire.cache[ttsPath] = {
  id: ttsPath,
  filename: ttsPath,
  loaded: true,
  exports: {
    fetchAudio: async (text: string): Promise<string> => {
      ttsInputs.push(text);
      return `blob:m9f01-l2-${ttsInputs.length}`;
    },
  },
} as unknown as NodeModule;

// —— client 桩：chatConversation（syncEnabled=true 时本不会被调用，桩住以防初始化路径） ——
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

const getSessionStore = () => {
  const mod = nodeRequire('../../../stores/playbackSessionStore') as typeof import('../../../stores/playbackSessionStore');
  return mod.usePlaybackSessionStore;
};
const getTransportStore = () => {
  const mod = nodeRequire('../../../stores/playbackStore') as typeof import('../../../stores/playbackStore');
  return mod.usePlaybackStore;
};
const getChatStore = () => {
  const mod = nodeRequire('../../../stores/chatStore') as typeof import('../../../stores/chatStore');
  return mod.useChatStore;
};
const getFlow = () =>
  nodeRequire('../../../app/services/playbackSessionFlow') as typeof import('../../../app/services/playbackSessionFlow');

const newSessionId = (): string => crypto.randomUUID();

/** 生成 N 个独立长段落（每段 >80 且 <350，避免合并/拆分，总段数恒为 N）。 */
const makeStoryText = (paras: number): string => {
  const parts: string[] = [];
  for (let i = 1; i <= paras; i += 1) {
    parts.push(
      `第${i}章：故事段落内容填充足够长度以避免前向合并策略将其合并到相邻段落之中保持独立成段${'内容'.repeat(30)}尾${i}`,
    );
  }
  return parts.join('\n');
};

type PlayRecord = { url: string; sourceKind: string | null; status: string };

/** 安装 fake controller，并在每次 play 时断言 M9-F01 全局 invariant。 */
function installSessionGuardedController(playCalls: PlayRecord[]): void {
  const useSession = getSessionStore();
  getTransportStore().getState().registerAudioController({
    unlock: async () => {},
    play: async (url: string) => {
      const session = useSession.getState();
      const sourceKind = session.source ? session.source.kind : null;
      if (sourceKind === null || session.status === 'idle') {
        throw new Error(
          `M9-F01 违约：Transport.play 时不存在正式 Session（source=${String(session.source)}, status=${session.status}）`,
        );
      }
      playCalls.push({ url, sourceKind, status: session.status });
    },
    resume: async () => {},
    pause: () => {},
    seek: () => {},
    setPlaybackRate: () => {},
  });
}

function resetPlaybackWorld(): void {
  const mod = nodeRequire('../../../stores/playbackSessionStore') as typeof import('../../../stores/playbackSessionStore');
  mod.__resetPlaybackSessionTestHooks();
  getSessionStore().getState().reset();
  getTransportStore().getState().reset();
  ttsInputs.length = 0;
}

function seedLegacyCardMessage(messageId: string, storyText: string, audioUrl: string): void {
  getChatStore().setState({
    // syncEnabled=true：initForUser 早退，保留本用例内存快照（避免重拉覆盖）。
    syncEnabled: true,
    messages: [
      {
        id: messageId,
        role: 'assistant',
        content: storyText,
        parts: [{ type: 'storyCard', storyText, audioUrl }],
        status: 'delivered',
      },
    ],
  } as never);
}

async function runStorycardSessionFlowIntegrationTests(): Promise<void> {
  const { prisma } = await setupIsolatedDb('storycard-session-flow');
  const { getPlaybackAnchorForSubject, beginPlaybackSessionForSubject } = await import(
    '../../../lib/server/playbackSession'
  );
  const { createStoryWorkForSubject } = await import('../../../lib/server/storyWork');
  const flow = getFlow();
  const useSession = getSessionStore();
  const useTransport = getTransportStore();

  console.log('=== M9-F01: StoryCard / History playback entries (integration, real server) ===');

  // ==========================================================================
  // A：Legacy storyCard（含 persisted audioUrl）→ 正式 Draft Session
  // ==========================================================================
  console.log('--- A: legacy storyCard (with persisted audioUrl) → formal draft Session ---');
  {
    resetPlaybackWorld();
    const guestA: Subject = { type: 'guest', id: makeGuestId('m9f01_flow_a') };
    subjectRef.current = guestA;
    const messageId = makeMessageId('m9f01_draft_a');
    const storyText = makeStoryText(4);
    const expectedParagraphs = segmentStoryText(normalizeStoryText(storyText));
    const expectedHash = computeStoryContentHash(normalizeStoryText(storyText));
    assert.strictEqual(expectedParagraphs.length, 4, '前置：A 正文切分为 4 段');
    await prisma.guestChatMessage.create({
      data: {
        guestId: guestA.id,
        position: 0,
        messageId,
        role: 'assistant',
        content: storyText,
        parts: JSON.stringify([
          { type: 'storyCard', storyText, audioUrl: 'https://legacy.example.com/whole.mp3' },
        ]),
      },
    });
    seedLegacyCardMessage(messageId, storyText, 'https://legacy.example.com/whole.mp3');
    const playCalls: PlayRecord[] = [];
    installSessionGuardedController(playCalls);

    await flow.playStoryCard({ messageId, storyText });

    const session = useSession.getState();
    assert.deepStrictEqual(
      session.source,
      { kind: 'draft', messageId },
      'A：Flow 必须建立 draft Session（source 来自稳定 identity）',
    );
    assert.strictEqual(session.paragraphs.length, session.totalParagraphs, 'A：paragraphs 与 totalParagraphs 必须一致');
    assert.strictEqual(session.totalParagraphs, 4, 'A：total 来自 canonical 切分');
    assert.strictEqual(session.contentHash, expectedHash, 'A：contentHash 来自 canonical 文本');
    assert.strictEqual(session.segmentationVersion, SEGMENTATION_VERSION, 'A：segmentationVersion 对齐 SSOT');
    assert.strictEqual(session.continuationMode, 'finite', 'A：Draft live session 默认 finite');

    const anchor = await getPlaybackAnchorForSubject(guestA);
    assert.ok(anchor, 'A：真 server 必须落 Anchor');
    assert.deepStrictEqual(anchor?.source, { kind: 'draft', messageId }, 'A：Anchor source=draft/messageId');
    assert.strictEqual(anchor?.sessionId, session.sessionId, 'A：server Anchor 与本地 Session 同 id');
    assert.strictEqual(anchor?.totalParagraphs, 4, 'A：server 落 canonical 段数');
    assert.strictEqual(anchor?.contentHash, expectedHash, 'A：server 落 canonical hash');

    assert.strictEqual(ttsInputs.length, 1, 'A：恰好合成首段（legacy 整篇 audioUrl 不得充当 paragraph 0）');
    assert.strictEqual(ttsInputs[0], expectedParagraphs[0], 'A：TTS 输入 = paragraphs[0]');
    assert.strictEqual(playCalls.length, 1, 'A：恰好播放一次');
    assert.ok(
      !playCalls[0].url.includes('legacy.example.com'),
      'A：播放不得使用 legacy persisted audioUrl（无 segment identity）',
    );
    assert.strictEqual(playCalls[0].sourceKind, 'draft', 'A：play 时已有正式 Session');
    console.log('PASS: A legacy storyCard → formal draft session');
  }

  // ==========================================================================
  // B：replay-text-* 瞬态 id fail-closed
  // ==========================================================================
  console.log('--- B: replay-text-* transient id fail-closed ---');
  {
    resetPlaybackWorld();
    const guestB: Subject = { type: 'guest', id: makeGuestId('m9f01_flow_b') };
    subjectRef.current = guestB;
    assert.strictEqual(isValidDraftMessageId(`${REPLAY_TEXT_PREFIX}abc`), false, 'B：前缀即非法 identity');
    await flow.playStoryCard({ messageId: `${REPLAY_TEXT_PREFIX}abc`, storyText: makeStoryText(2) });
    assert.strictEqual(useSession.getState().source, null, 'B：瞬态 id 不得建立 Session');
    assert.strictEqual(await getPlaybackAnchorForSubject(guestB), null, 'B：瞬态 id 不得落 Anchor');
    assert.strictEqual(ttsInputs.length, 0, 'B：不得触发合成');
    console.log('PASS: B replay-text-* fail-closed');
  }

  // ==========================================================================
  // C：server begin 门（同 source resume 新 UUID / restart 同 UUID 一律 BAD_REQUEST）
  // ==========================================================================
  console.log('--- C: server begin guards ---');
  {
    resetPlaybackWorld();
    const guestC: Subject = { type: 'guest', id: makeGuestId('m9f01_flow_c') };
    subjectRef.current = guestC;
    const messageId = makeMessageId('m9f01_draft_c');
    const storyText = makeStoryText(3);
    const paragraphs = segmentStoryText(normalizeStoryText(storyText));
    await prisma.guestChatMessage.create({
      data: {
        guestId: guestC.id,
        position: 0,
        messageId,
        role: 'assistant',
        content: storyText,
        parts: JSON.stringify([{ type: 'storyCard', storyText, audioUrl: '' }]),
      },
    });
    seedLegacyCardMessage(messageId, storyText, '');
    installSessionGuardedController([]);
    await flow.playStoryCard({ messageId, storyText });
    const established = useSession.getState();
    assert.ok(established.sessionId, 'C：前置 Session 已建立');
    const draftSnapshot = {
      title: established.title,
      contentHash: established.contentHash,
      totalParagraphs: established.totalParagraphs,
      voiceId: established.voiceId,
    };
    const source = { kind: 'draft', messageId } as const;

    // C1：同 source + 新 UUID + resume → BAD_REQUEST（resume 必须沿用原 sessionId）。
    await assert.rejects(
      () =>
        beginPlaybackSessionForSubject(guestC, {
          sessionId: newSessionId(),
          source,
          mode: 'resume',
          speed: 1,
          draftSnapshot,
        }),
      (err: unknown) => err instanceof TRPCError && (err as TRPCError).code === 'BAD_REQUEST',
      'C1：同 source 新 UUID resume 必须 BAD_REQUEST',
    );

    // C2：restart 沿用旧 sessionId → BAD_REQUEST（新会话必须新 UUID）。
    await assert.rejects(
      () =>
        beginPlaybackSessionForSubject(guestC, {
          sessionId: established.sessionId as string,
          source,
          mode: 'restart',
          speed: 1,
          draftSnapshot,
        }),
      (err: unknown) => err instanceof TRPCError && (err as TRPCError).code === 'BAD_REQUEST',
      'C2：restart 必须使用新 UUID',
    );

    // C3：同 source + 新 UUID + restart → 接受（这正是 Flow 的新会话路径）。
    const restarted = await beginPlaybackSessionForSubject(guestC, {
      sessionId: newSessionId(),
      source,
      mode: 'restart',
      speed: 1,
      draftSnapshot,
    });
    assert.notStrictEqual(restarted.sessionId, established.sessionId, 'C3：restart 建立新 sessionId');
    assert.strictEqual(restarted.nextParagraphIndex, 0, 'C3：restart 从 0 起');
    console.log('PASS: C server begin guards');
  }

  // ==========================================================================
  // D：Work 切换（History A → B）最终归属最后一次操作
  // ==========================================================================
  console.log('--- D: work switch via History flow (last intent wins) ---');
  {
    resetPlaybackWorld();
    const guestD: Subject = { type: 'guest', id: makeGuestId('m9f01_flow_d') };
    subjectRef.current = guestD;
    const textA = makeStoryText(3);
    const textB = makeStoryText(3);
    const workA = await createStoryWorkForSubject(guestD, {
      prompt: 'M9-F01 L2 work A 提示词足够长',
      storyText: textA,
    });
    const workB = await createStoryWorkForSubject(guestD, {
      prompt: 'M9-F01 L2 work B 提示词足够长',
      storyText: textB,
    });
    const paragraphsB = segmentStoryText(normalizeStoryText(textB));
    const playCalls: PlayRecord[] = [];
    installSessionGuardedController(playCalls);

    await flow.playWorkFromHistory(workA.id);
    const sessionA = useSession.getState();
    assert.deepStrictEqual(sessionA.source, { kind: 'work', workId: workA.id }, 'D：首个 Work 建立 work Session');
    const sessionIdA = sessionA.sessionId;
    assert.ok(sessionIdA, 'D：workA 有 sessionId');
    assert.strictEqual(ttsInputs.length, 1, 'D：workA 起播合成一段');
    const anchorA = await getPlaybackAnchorForSubject(guestD);
    assert.deepStrictEqual(anchorA?.source, { kind: 'work', workId: workA.id }, 'D：server Anchor=workA');

    await flow.playWorkFromHistory(workB.id);
    const sessionB = useSession.getState();
    assert.deepStrictEqual(sessionB.source, { kind: 'work', workId: workB.id }, 'D：切换后归属 workB');
    assert.notStrictEqual(sessionB.sessionId, sessionIdA, 'D：切换 Work 必须新 sessionId');
    assert.strictEqual(ttsInputs.length, 2, 'D：workB 起播恰好再合成一段');
    assert.strictEqual(ttsInputs[1], paragraphsB[0], 'D：workB TTS 输入 = 其 paragraphs[0]');
    const anchorB = await getPlaybackAnchorForSubject(guestD);
    assert.deepStrictEqual(anchorB?.source, { kind: 'work', workId: workB.id }, 'D：server Anchor 收敛到 workB');
    assert.strictEqual(anchorB?.sessionId, sessionB.sessionId, 'D：本地与 server 一致（旧 begin 不得晚到覆盖）');
    assert.ok(
      playCalls.every((call) => call.sourceKind === 'work'),
      'D：每次 play 都在正式 Session 下',
    );
    console.log('PASS: D work switch last-intent-wins');
  }

  // ==========================================================================
  // E：同 Work —— 出声中 → 正式 pause；断点位 → resume（sessionId 不变）
  // ==========================================================================
  console.log('--- E: same work pause / resume at breakpoint ---');
  {
    resetPlaybackWorld();
    const guestE: Subject = { type: 'guest', id: makeGuestId('m9f01_flow_e') };
    subjectRef.current = guestE;
    const textE = makeStoryText(3);
    const workE = await createStoryWorkForSubject(guestE, {
      prompt: 'M9-F01 L2 work E 提示词足够长',
      storyText: textE,
    });
    const paragraphsE = segmentStoryText(normalizeStoryText(textE));
    assert.strictEqual(paragraphsE.length, 3, 'E：前置 3 段');
    installSessionGuardedController([]);

    await flow.playWorkFromHistory(workE.id);
    const sessionIdE = useSession.getState().sessionId;
    assert.strictEqual(ttsInputs.length, 1, 'E：起播合成一段（fake controller 无真实 playing 事件）');
    // fake controller 不会触发宿主 playing 事件，显式模拟 Transport 出声态。
    useTransport.setState({ isPlaying: true });
    assert.strictEqual(useTransport.getState().isPlaying, true, 'E：前置 Transport 出声中');

    // 出声中再次点击 → 正式 pause，不得重复合成/重启。
    await flow.playWorkFromHistory(workE.id);
    assert.strictEqual(useTransport.getState().isPlaying, false, 'E：同 Work 出声中点击 → 正式 pause');
    assert.strictEqual(useSession.getState().sessionId, sessionIdE, 'E：pause 不换 sessionId');
    assert.strictEqual(ttsInputs.length, 1, 'E：pause 不触发合成');

    // 模拟断点在第 3 段（next=2）后 resume → 只合成断点段，sessionId 不变。
    useSession.setState({ nextParagraphIndex: 2 });
    await flow.playWorkFromHistory(workE.id);
    assert.strictEqual(useSession.getState().sessionId, sessionIdE, 'E：resume 保持 sessionId（不 restart）');
    assert.strictEqual(ttsInputs.length, 2, 'E：resume 只补合成断点段');
    assert.strictEqual(ttsInputs[1], paragraphsE[2], 'E：resume 合成 nextParagraphIndex 段');
    assert.strictEqual(useSession.getState().nextParagraphIndex, 2, 'E：断点位被正确定位');

    const anchorE = await getPlaybackAnchorForSubject(guestE);
    assert.strictEqual(anchorE?.sessionId, sessionIdE, 'E：resume 不改变 server Session');
    console.log('PASS: E same work pause/resume');
  }

  assert.strictEqual(toastCapture.lastToast, null, '全链路不得以 toast 掩盖失败');
  console.log('\nALL M9-F01 STORYCARD SESSION FLOW INTEGRATION TESTS PASSED!');
}

const testPromise = runStorycardSessionFlowIntegrationTests()
  .then(() => {
    console.log('ALL M9-F01 STORYCARD SESSION FLOW INTEGRATION TESTS PASSED!');
  })
  .catch((error) => {
    console.error('Storycard session flow integration test failed:', error);
    process.exit(1);
  });

export default testPromise;
