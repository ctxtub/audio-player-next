import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  createToastCapture,
  installGlassToastStub,
} from '../../support/mocks/ui-state.mock';
import {
  SEGMENTATION_VERSION,
  computeStoryContentHash,
  normalizeStoryText,
  segmentStoryText,
} from '../../../utils/segmentation';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const toastCapture = createToastCapture();
installGlassToastStub(toastCapture);

// 中文注释：fetchAudio 可编程桩（捕获 TTS 输入文本 + 支持 deferred，证明 Flow 级
// stale TTS 丢弃与 paragraph 级合成）。必须在任何 store/flow 被求值之前劫持 require 缓存。
type FetchBehavior = (text: string) => Promise<string>;
const fetchQueue: FetchBehavior[] = [];
const ttsInputs: string[] = [];
let fetchCalls = 0;
function deferText() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const ttsPath = path.resolve(process.cwd(), 'lib/client/ttsGenerate.ts');
nodeRequire.cache[ttsPath] = {
  id: ttsPath,
  filename: ttsPath,
  loaded: true,
  exports: {
    fetchAudio: async (text: string): Promise<string> => {
      fetchCalls += 1;
      ttsInputs.push(text);
      const behavior = fetchQueue.shift();
      if (behavior) return behavior(text);
      return `blob:mock-storycard-${fetchCalls}`;
    },
  },
} as unknown as NodeModule;

// 中文注释：server beginSession 回显桩（模拟服务端语义，不触网/库；真实服务端契约由 L2 覆盖）。
// - Draft：原样持久化 client draftSnapshot（position 恒 0），回显合法 Anchor；
// - Work：模拟 Manifest 缺失本地回退（totalParagraphs/contentHash 由测试预置，与 library 桩同源）。
// - 支持 per-call deferred，证明 begin 竞态下 post-begin source-match 守卫。
type BeginBehavior = (input: {
  sessionId: string;
  source: { kind: string; messageId?: string; workId?: number };
  mode: string;
  speed: number;
  draftSnapshot?: { title: string; contentHash: string; totalParagraphs: number; voiceId: string };
}) => Promise<Record<string, unknown>>;
const beginQueue: BeginBehavior[] = [];
const beginInputs: Array<Record<string, unknown>> = [];
const workEchoMeta = {
  title: '历史作品',
  contentHash: '',
  totalParagraphs: 4,
  voiceId: 'alloy',
};
function defaultBeginEcho(input: Parameters<BeginBehavior>[0]): Record<string, unknown> {
  if (input.source.kind === 'draft') {
    const snap = input.draftSnapshot ?? {
      title: '未命名故事',
      contentHash: '',
      totalParagraphs: 1,
      voiceId: '',
    };
    return {
      sessionId: input.sessionId,
      source: { kind: 'draft', messageId: input.source.messageId },
      state: 'ready',
      title: snap.title,
      contentHash: snap.contentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: -1,
      nextParagraphIndex: 0,
      totalParagraphs: snap.totalParagraphs,
      voiceId: snap.voiceId,
      speed: input.speed,
      remainingAllowedMs: null,
      totalAllowedMs: null,
      sleepTimerMode: 'off',
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    sessionId: input.sessionId,
    source: { kind: 'work', workId: input.source.workId },
    state: 'ready',
    title: workEchoMeta.title,
    contentHash: workEchoMeta.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: -1,
    nextParagraphIndex: 0,
    totalParagraphs: workEchoMeta.totalParagraphs,
    voiceId: workEchoMeta.voiceId,
    speed: input.speed,
    remainingAllowedMs: null,
    totalAllowedMs: null,
    sleepTimerMode: 'off',
    updatedAt: new Date().toISOString(),
  };
}
const playbackSessionClientPath = path.resolve(process.cwd(), 'lib/client/playbackSession.ts');
nodeRequire.cache[playbackSessionClientPath] = {
  id: playbackSessionClientPath,
  filename: playbackSessionClientPath,
  loaded: true,
  exports: {
    getPlaybackAnchor: async () => null,
    beginPlaybackSession: async (input: Parameters<BeginBehavior>[0]) => {
      beginInputs.push(input as unknown as Record<string, unknown>);
      const behavior = beginQueue.shift();
      if (behavior) return behavior(input);
      return defaultBeginEcho(input);
    },
    savePlaybackCheckpoint: async () => ({ accepted: true }),
    completePlaybackSession: async () => null,
    clearPlaybackAnchor: async () => ({ cleared: false }),
    promoteDraftPlaybackToWork: async () => {
      throw new Error('not implemented in M9-F01 L1 stub');
    },
    setSleepTimer: async () => ({ accepted: false, reason: 'STALE_SESSION' }),
  },
} as unknown as NodeModule;

// 中文注释：library.get 桩（Work hydrate 精确 resolve 面；与 workEchoMeta 同源文本）。
const WORK_ID = 4242;
const libraryPath = path.resolve(process.cwd(), 'lib/client/library.ts');
nodeRequire.cache[libraryPath] = {
  id: libraryPath,
  filename: libraryPath,
  loaded: true,
  exports: {
    get: async ({ id }: { id: number }) => {
      assert.strictEqual(id, WORK_ID, 'L1 library 桩只服务本文件 Work 用例');
      return {
        id: WORK_ID,
        title: workEchoMeta.title,
        prompt: '历史提示词',
        storyText: WORK_TEXT,
        voiceId: workEchoMeta.voiceId,
        contentHash: workEchoMeta.contentHash,
        favoritedAt: null,
        deletedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
    list: async () => ({ items: [], nextCursor: null }),
  },
} as unknown as NodeModule;

// 中文注释：storyAudio 桩（Manifest 缺失 → 本地回退合法路径；canonical provider 关闭）。
const storyAudioPath = path.resolve(process.cwd(), 'lib/client/storyAudio.ts');
nodeRequire.cache[storyAudioPath] = {
  id: storyAudioPath,
  filename: storyAudioPath,
  loaded: true,
  exports: {
    ensureSegment: async () => {
      throw new Error('canonical provider closed in M9-F01 L1');
    },
    ensureAsset: async () => {
      throw new Error('single-track provider closed in M9-F01 L1');
    },
    getProjection: async () => {
      throw new Error('single-track projection closed in M9-F01 L1');
    },
    saveProgress: async () => ({ written: false }),
    getPlaybackManifest: async () => null,
    isCanonicalPlaybackUrl: () => false,
    isSingleTrackPlaybackUrl: () => false,
    selectWorkParagraphs: (local: string[]) => local,
    shouldUseCanonicalAudio: () => false,
    shouldUseSingleTrackAudio: () => false,
  },
} as unknown as NodeModule;

// 中文注释：chatConversation 桩（hydrate 内 ensureChatLoaded 快速失败，不挂网络；
/// ChatStore 运行时种子不受影响——失败分支直接 catch 继续快照解析）。
const chatConversationPath = path.resolve(process.cwd(), 'lib/client/chatConversation.ts');
nodeRequire.cache[chatConversationPath] = {
  id: chatConversationPath,
  filename: chatConversationPath,
  loaded: true,
  exports: {
    fetchMyConversation: async () => {
      throw new Error('no server in L1');
    },
    saveMyConversation: async () => {},
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
const getConfigStore = () => {
  const mod = nodeRequire('../../../stores/configStore') as typeof import('../../../stores/configStore');
  return mod.useConfigStore;
};
const getChatStore = () => {
  const mod = nodeRequire('../../../stores/chatStore') as typeof import('../../../stores/chatStore');
  return mod.useChatStore;
};
const getFlow = () =>
  nodeRequire('../../../app/services/playbackSessionFlow') as typeof import('../../../app/services/playbackSessionFlow');
const getMiniDerived = () =>
  nodeRequire('../../../components/NowPlaying/deriveMiniNowPlayingViewModel') as typeof import('../../../components/NowPlaying/deriveMiniNowPlayingViewModel');
const getWorkNav = () =>
  nodeRequire('../../../components/NowPlaying/workViewStoryNavigation') as typeof import('../../../components/NowPlaying/workViewStoryNavigation');

/**
 * M9-F01 StoryCard / History 经 PlaybackSessionFlow（L1 真实状态迁移 oracle）。
 *
 * 冻结公式（不动）：Mini 可见 = source !== null && status !== 'idle'。
 * 全局 invariant：Transport.play() 被调用的时刻 Session 必须已存在
 * （fake controller 每次 play 同步断言，见 installSessionGuardedController）。
 *
 * - A：legacy audioUrl + 无 Session → 新 Draft Session（messageId/seg/hash/total
 *   对齐，先 Session 后 audio，不复用 legacy URL，Mini 可见）。
 * - B：纯 storyText → TTS 输入=paragraphs[0] + Mini 可见。
 * - C：匹配断点 next=2/total=4 → 同 sessionId 从 paragraphs[2] resume。
 * - D1：切卡（A 在途 TTS → 点 B）→ B 获胜，A 晚到丢弃，Transport 不被抢回。
 * - D2：begin 竞态（A begin 晚到）→ A post-begin source-match abort，不起播。
 * - E：History record.id → {kind:'work',workId} finite + audio + Mini +
 *   Expanded 正文目标 `/library/{id}`；同 Work 断点 resume 保持 sessionId。
 * - F：ended 重播 → M5 restart 新 sessionId，从 paragraphs[0] 起播。
 * - G：同卡播放中 → 正式 pause（sessionId 不变，无新合成）。
 * - H：全入口静态审计（产品 playAudio 调用点 ⊆ SessionStore 等）。
 */

const MSG_A = 'msg_m9f01_card_a';
const MSG_B = 'msg_m9f01_card_b';
const MSG_C = 'msg_m9f01_card_c';
const MSG_G = 'msg_m9f01_card_g';
const MSG_F = 'msg_m9f01_card_f';
const SESSION_C = 'c47ac10b-58cc-4372-a567-0e02b2c3d479';
const SESSION_F = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const SESSION_G = '947ac10b-58cc-4372-a567-0e02b2c3d479';
const LEGACY_AUDIO_URL = 'https://example.com/legacy-whole-story.mp3';

const PARA1 =
  '第一自然段：很久很久以前，在宁静的大森林深处住着一只聪明活泼的小松鼠，它有一条蓬松的大尾巴，每天清晨都在高高的树梢间欢快地跳来跳去，寻找新鲜的坚果与甘甜的露水。';
const PARA2 =
  '第二自然段：小松鼠每天早晨迎着金色的朝阳出门收集松果，仔细辨别每一颗果实是否饱满香甜，并将它们整齐地存放在自己温暖干燥的树洞深处，准备迎接即将到来的寒冷冬天。它还会在洞口铺上柔软的干草。';
const PARA3 =
  '第三自然段：有一天它在一棵巨大的古老松树下发现了一颗闪闪发光的神奇松果，散发出奇异而温暖的柔和光芒，不仅照亮了周围湿漉漉的青苔，还散发出一种让人心情平静的香气。';
const PARA4 =
  '第四自然段：这颗发光的松果带领着好奇的小松鼠走进了森林最深处的奇妙花园，那里盛开着从未见过的美丽奇幻花朵，彩色的蝴蝶在花丛中翩翩起舞，宛如梦境一般美丽动人。小松鼠决定把这份喜悦分享给森林里的每一位朋友。';
const STORY_TEXT = `${PARA1}\n${PARA2}\n${PARA3}\n${PARA4}`;
const WORK_TEXT = STORY_TEXT;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

function resetPlaybackWorld(): void {
  const useSession = getSessionStore();
  const useTransport = getTransportStore();
  const { __resetPlaybackSessionTestHooks } = nodeRequire(
    '../../../stores/playbackSessionStore',
  ) as typeof import('../../../stores/playbackSessionStore');
  __resetPlaybackSessionTestHooks();
  useSession.getState().reset();
  try {
    const intervalId = (useTransport.getState() as unknown as { _tickIntervalId: number | null })
      ._tickIntervalId;
    if (intervalId !== null) {
      clearInterval(intervalId as unknown as Parameters<typeof clearInterval>[0]);
    }
  } catch {
    // 清理失败忽略。
  }
  useTransport.getState().reset();
  useTransport.setState({
    _tickIntervalId: null,
    _lastTickAt: null,
    isPlaying: false,
  });
  try {
    getChatStore().getState().reset();
  } catch {
    // chat store 不可用不阻断。
  }
  ttsInputs.length = 0;
  fetchCalls = 0;
  fetchQueue.length = 0;
  beginQueue.length = 0;
  beginInputs.length = 0;
}

type SessionAtPlay = { source: unknown; status: unknown };

/**
 * 会话守卫型 fake controller：每次 play() 同步记录 Session 快照并立即断言
 * 全局 invariant（source 非空且 status 非 idle），不是播放后再补 Session。
 */
function installSessionGuardedController(playCalls: string[], atPlay: SessionAtPlay[]): void {
  const paused: string[] = [];
  getTransportStore().getState().registerAudioController({
    unlock: async () => {},
    play: async (audioUrl: string) => {
      const session = getSessionStore().getState();
      atPlay.push({ source: session.source, status: session.status });
      assert.ok(
        session.source !== null && session.status !== 'idle',
        `INVARIANT 破口：play(${audioUrl}) 时 Session 仍为空 ` +
          `(source=${JSON.stringify(session.source)} status=${String(session.status)})`,
      );
      playCalls.push(audioUrl);
    },
    resume: async () => {},
    pause: () => {
      paused.push('paused');
    },
    seek: () => {},
    setPlaybackRate: () => {},
  });
  return void paused;
}

function seedLegacyCardMessage(messageId: string, storyText: string, audioUrl: string): void {
  getChatStore().setState({
    messages: [
      {
        id: messageId,
        role: 'assistant',
        content: storyText,
        parts: [{ type: 'storyCard', storyText, audioUrl }],
        status: 'delivered',
      },
    ] as never,
  });
}

async function runStorycardSessionFlowTests(): Promise<void> {
  console.log('=== M9-F01: story playback entries via PlaybackSessionFlow (unit oracle) ===');

  const expectedParagraphs = segmentStoryText(normalizeStoryText(STORY_TEXT));
  assert.strictEqual(expectedParagraphs.length, 4, '前置：故事正文必须切分为 4 段');
  const expectedHash = computeStoryContentHash(normalizeStoryText(STORY_TEXT));
  workEchoMeta.contentHash = expectedHash;

  const useConfig = getConfigStore();
  useConfig.setState({
    apiConfig: {
      ...useConfig.getState().apiConfig,
      voiceId: 'alloy',
      speed: 1,
      playDuration: 30,
      defaultSleepTimerMinutes: 30,
      defaultSleepTimerEnabled: false,
    },
  });

  // —— A：legacy audioUrl + 无 Session → 新 Draft Session（先 Session 后 audio） ——
  console.log('--- A: legacy audioUrl + no session → draft session first, audio second ---');
  resetPlaybackWorld();
  const playA: string[] = [];
  const atPlayA: SessionAtPlay[] = [];
  installSessionGuardedController(playA, atPlayA);
  const useSession = getSessionStore();
  const useTransport = getTransportStore();
  seedLegacyCardMessage(MSG_A, STORY_TEXT, LEGACY_AUDIO_URL);
  assert.strictEqual(useSession.getState().source, null, 'A 前置：无 Session');
  await getFlow().playStoryCard({ messageId: MSG_A, storyText: STORY_TEXT });
  const sA = useSession.getState();
  assert.deepStrictEqual(sA.source, { kind: 'draft', messageId: MSG_A }, 'A：source.messageId=卡片稳定 id');
  assert.notStrictEqual(sA.status, 'idle', 'A：非 idle Draft Session');
  assert.ok(sA.sessionId, 'A：必须有 sessionId');
  assert.strictEqual(sA.paragraphs.length, 4, 'A：paragraphs.length 对齐');
  assert.strictEqual(sA.totalParagraphs, 4, 'A：totalParagraphs 对齐');
  assert.strictEqual(sA.paragraphs.length, sA.totalParagraphs, 'A：paragraphs.length===totalParagraphs');
  assert.strictEqual(sA.contentHash, expectedHash, 'A：contentHash 与 canonical 一致');
  assert.strictEqual(sA.nextParagraphIndex, 0, 'A：新 Session 从正式起点起播');
  assert.strictEqual(ttsInputs.length, 1, 'A：恰好合成一次');
  assert.strictEqual(ttsInputs[0], expectedParagraphs[0], 'A：TTS 输入=paragraphs[0]（非整篇）');
  assert.strictEqual(playA.length, 1, 'A：audio 自然起播一次');
  assert.notStrictEqual(playA[0], LEGACY_AUDIO_URL, 'A：不得复用 legacy audioUrl（无 segment identity）');
  assert.strictEqual(useTransport.getState().currentAudioUrl, playA[0]);
  assert.strictEqual(atPlayA.length, 1, 'A：play 时刻快照恰一次');
  assert.deepStrictEqual(atPlayA[0].source, { kind: 'draft', messageId: MSG_A }, 'A：第一次 Transport.play 时 Session 已存在');
  assert.notStrictEqual(atPlayA[0].status, 'idle');
  const { hasMiniNowPlaying } = getMiniDerived();
  assert.strictEqual(
    hasMiniNowPlaying({ source: sA.source, status: sA.status } as never),
    true,
    'A：Session 快照满足 Mini 可见条件',
  );
  const beginA = beginInputs[beginInputs.length - 1] as unknown as {
    source: unknown;
    mode: string;
    draftSnapshot: { title: string; contentHash: string; totalParagraphs: number; voiceId: string };
  };
  assert.deepStrictEqual(beginA.source, { kind: 'draft', messageId: MSG_A }, 'A：begin 用真实 Draft identity');
  assert.ok(!String((beginA.source as { messageId: string }).messageId).startsWith('replay-text-'), 'A：禁伪 identity');
  assert.strictEqual(beginA.draftSnapshot.totalParagraphs, 4, 'A：snapshot total 对齐');
  assert.strictEqual(beginA.draftSnapshot.contentHash, expectedHash, 'A：snapshot hash 对齐');
  console.log('PASS: A legacy-audioUrl card enters session flow');

  // —— B：纯 storyText → TTS/正式 provider + Mini 可见 ——
  console.log('--- B: storyText-only card → draft session + provider audio + mini ---');
  resetPlaybackWorld();
  const playB: string[] = [];
  const atPlayB: SessionAtPlay[] = [];
  installSessionGuardedController(playB, atPlayB);
  seedLegacyCardMessage(MSG_B, STORY_TEXT, '');
  await getFlow().playStoryCard({ messageId: MSG_B, storyText: STORY_TEXT });
  const sB = useSession.getState();
  assert.deepStrictEqual(sB.source, { kind: 'draft', messageId: MSG_B });
  assert.notStrictEqual(sB.status, 'idle');
  assert.strictEqual(ttsInputs.length, 1);
  assert.strictEqual(ttsInputs[0], expectedParagraphs[0], 'B：TTS 只为当前 paragraph 工作');
  assert.strictEqual(playB.length, 1, 'B：audio 起播');
  assert.strictEqual(atPlayB.length, 1, 'B：play 时 Session 先在');
  assert.strictEqual(
    getMiniDerived().hasMiniNowPlaying({ source: sB.source, status: sB.status } as never),
    true,
    'B：Mini 可见条件成立',
  );
  console.log('PASS: B storyText-only card enters session flow');

  // —— C：匹配断点 next=2/total=4 → 同 sessionId 从 paragraphs[2] resume ——
  console.log('--- C: matching breakpoint next=2/total=4 → resume same session ---');
  resetPlaybackWorld();
  const playC: string[] = [];
  const atPlayC: SessionAtPlay[] = [];
  installSessionGuardedController(playC, atPlayC);
  seedLegacyCardMessage(MSG_C, STORY_TEXT, '');
  useSession.getState().setActiveStory({
    source: { kind: 'draft', messageId: MSG_C },
    sessionId: SESSION_C,
    title: '小松鼠的故事',
    storyText: STORY_TEXT,
    voiceId: 'alloy',
    speed: 1,
    initialNextIndex: 2,
  });
  assert.strictEqual(useSession.getState().nextParagraphIndex, 2, 'C 前置：断点 next=2');
  await getFlow().playStoryCard({ messageId: MSG_C, storyText: STORY_TEXT });
  assert.strictEqual(useSession.getState().sessionId, SESSION_C, 'C：resume 保持当前 sessionId');
  assert.strictEqual(useSession.getState().nextParagraphIndex, 2, 'C：保持 canonical next');
  assert.strictEqual(ttsInputs.length, 1, 'C：恰好合成一次');
  assert.strictEqual(ttsInputs[0], expectedParagraphs[2], 'C：从 paragraphs[2] 播放（按钮“从第 3 段继续收听”同源）');
  assert.strictEqual(playC.length, 1, 'C：播一次');
  assert.strictEqual(atPlayC.length, 1, 'C：play 时 Session 先在');
  assert.strictEqual(beginInputs.length, 0, 'C：不得 begin 第二个 Session');
  console.log('PASS: C breakpoint resume reuses session');

  // —— D1：切卡（A 在途 TTS → 点 B）→ B 获胜，A 晚到丢弃 ——
  console.log('--- D1: card switch → late A TTS discarded, transport keeps B ---');
  resetPlaybackWorld();
  const playD: string[] = [];
  const atPlayD: SessionAtPlay[] = [];
  installSessionGuardedController(playD, atPlayD);
  seedLegacyCardMessage(MSG_A, STORY_TEXT, '');
  getChatStore().setState({
    messages: [
      {
        id: MSG_A,
        role: 'assistant',
        content: STORY_TEXT,
        parts: [{ type: 'storyCard', storyText: STORY_TEXT, audioUrl: '' }],
        status: 'delivered',
      },
      {
        id: MSG_B,
        role: 'assistant',
        content: STORY_TEXT,
        parts: [{ type: 'storyCard', storyText: STORY_TEXT, audioUrl: '' }],
        status: 'delivered',
      },
    ] as never,
  });
  const lateA = deferText();
  let aFetchEntered!: () => void;
  const aFetchStarted = new Promise<void>((resolve) => {
    aFetchEntered = resolve;
  });
  fetchQueue.push(() => {
    aFetchEntered();
    return lateA.promise;
  });
  const pendingA = getFlow().playStoryCard({ messageId: MSG_A, storyText: STORY_TEXT });
  // 确定性等待 A 真正进入在途 TTS（其 Session 已建立），再触发 B 的切换。
  await aFetchStarted;
  assert.deepStrictEqual(useSession.getState().source, { kind: 'draft', messageId: MSG_A }, 'D1 前置：A 已建 Session 且 TTS 在途');
  const pendingB = getFlow().playStoryCard({ messageId: MSG_B, storyText: STORY_TEXT });
  await pendingB;
  const sDAfterB = useSession.getState();
  assert.deepStrictEqual(sDAfterB.source, { kind: 'draft', messageId: MSG_B }, 'D1：source 已切换到 B');
  const sessionB = sDAfterB.sessionId;
  assert.ok(sessionB, 'D1：B sessionId 存在');
  lateA.resolve('blob:stale-a');
  await pendingA;
  assert.ok(!playD.includes('blob:stale-a'), 'D1：A 的晚到 TTS 被 stale guard 丢弃');
  assert.strictEqual(playD.length, 1, 'D1：Transport 只播 B，不被 A 抢回');
  assert.strictEqual(useTransport.getState().currentAudioUrl, playD[0]);
  assert.deepStrictEqual(useSession.getState().source, { kind: 'draft', messageId: MSG_B }, 'D1：Session 仍是 B');
  assert.strictEqual(useSession.getState().sessionId, sessionB, 'D1：sessionId 仍是 B');
  assert.strictEqual(
    getMiniDerived().hasMiniNowPlaying({
      source: useSession.getState().source,
      status: useSession.getState().status,
    } as never),
    true,
    'D1：Mini 展示 B（Session 可见）',
  );
  for (const snap of atPlayD) {
    assert.ok(snap.source !== null && snap.status !== 'idle', 'D1：每次 play 时 Session 先在');
  }
  console.log('PASS: D1 switch stale guard verified');

  // —— D2：begin 竞态（A begin 晚到）→ post-begin source-match abort ——
  console.log('--- D2: late begin → source-match abort, no second play ---');
  resetPlaybackWorld();
  const playD2: string[] = [];
  const atPlayD2: SessionAtPlay[] = [];
  installSessionGuardedController(playD2, atPlayD2);
  getChatStore().setState({
    messages: [
      {
        id: MSG_A,
        role: 'assistant',
        content: STORY_TEXT,
        parts: [{ type: 'storyCard', storyText: STORY_TEXT, audioUrl: '' }],
        status: 'delivered',
      },
      {
        id: MSG_B,
        role: 'assistant',
        content: STORY_TEXT,
        parts: [{ type: 'storyCard', storyText: STORY_TEXT, audioUrl: '' }],
        status: 'delivered',
      },
    ] as never,
  });
  let resolveBeginA!: (value: Record<string, unknown>) => void;
  const beginAPromise = new Promise<Record<string, unknown>>((r) => {
    resolveBeginA = r;
  });
  let aBeginEntered!: () => void;
  const aBeginStarted = new Promise<void>((resolve) => {
    aBeginEntered = resolve;
  });
  beginQueue.push(() => {
    aBeginEntered();
    return beginAPromise;
  });
  const pendingA2 = getFlow().playStoryCard({ messageId: MSG_A, storyText: STORY_TEXT });
  // 确定性等待 A 的 begin 真正发出（被 gate 在途），再发出 B 的请求。
  await aBeginStarted;
  assert.strictEqual(playD2.length, 0, 'D2：A begin 未回前不得起播');
  assert.strictEqual(fetchCalls, 0, 'D2：A begin 未回前不得合成');
  const pendingB2 = getFlow().playStoryCard({ messageId: MSG_B, storyText: STORY_TEXT });
  // A 的晚到 begin 回包：A 会水合出自己的 source，但请求代已过期 → 必须 abort 不起播。
  resolveBeginA(
    defaultBeginEcho({
      sessionId: 'a47ac10b-58cc-4372-a567-0e02b2c3d47a',
      source: { kind: 'draft', messageId: MSG_A },
      mode: 'restart',
      speed: 1,
      draftSnapshot: {
        title: 't',
        contentHash: expectedHash,
        totalParagraphs: 4,
        voiceId: 'alloy',
      },
    }),
  );
  await pendingA2;
  await pendingB2;
  assert.deepStrictEqual(useSession.getState().source, { kind: 'draft', messageId: MSG_B }, 'D2：晚到 A begin 不得接管新 Session');
  assert.strictEqual(beginInputs.length, 2, 'D2：两次 begin 均已发出');
  assert.deepStrictEqual(
    (beginInputs[0] as { source: unknown }).source,
    { kind: 'draft', messageId: MSG_A },
    'D2：第一次 begin 属 A（随后被取代）',
  );
  assert.deepStrictEqual(
    (beginInputs[1] as { source: unknown }).source,
    { kind: 'draft', messageId: MSG_B },
    'D2：第二次 begin 属 B（最后一次操作胜出）',
  );
  assert.strictEqual(ttsInputs.length, 1, 'D2：仅 B 合成一次（A 被取代不合成）');
  assert.strictEqual(ttsInputs[0], expectedParagraphs[0], 'D2：B 从 paragraphs[0] 起播');
  assert.strictEqual(playD2.length, 1, 'D2：只播 B');
  assert.strictEqual(atPlayD2.length, 1);
  console.log('PASS: D2 late-begin abort verified');

  // —— E：Generation History → Work Session（finite + Mini + Expanded 可达） ——
  console.log('--- E: history record → work session finite + mini + expanded target ---');
  resetPlaybackWorld();
  const playE: string[] = [];
  const atPlayE: SessionAtPlay[] = [];
  installSessionGuardedController(playE, atPlayE);
  await getFlow().playWorkFromHistory(WORK_ID);
  const sE = useSession.getState();
  assert.deepStrictEqual(sE.source, { kind: 'work', workId: WORK_ID }, 'E：source.kind=work 且 workId=record.id');
  assert.notStrictEqual(sE.status, 'idle', 'E：正式 Work Session 非 idle');
  assert.strictEqual(sE.continuationMode, 'finite', 'E：历史回放一次性=finite，不触发 AI continuation');
  assert.strictEqual(sE.paragraphs.length, sE.totalParagraphs, 'E：paragraphs.length===totalParagraphs');
  assert.strictEqual(ttsInputs.length, 1, 'E：正式 provider 合成一次');
  assert.strictEqual(ttsInputs[0], expectedParagraphs[0], 'E：从正式起点起播');
  assert.strictEqual(playE.length, 1, 'E：audio 播放');
  assert.strictEqual(atPlayE.length, 1, 'E：play 时 Session 先在');
  assert.strictEqual(
    getMiniDerived().hasMiniNowPlaying({ source: sE.source, status: sE.status } as never),
    true,
    'E：Mini 可见',
  );
  assert.strictEqual(
    getWorkNav().resolveWorkLibraryTarget(sE.source as never),
    `/library/${WORK_ID}`,
    'E：Expanded 正文目标可达（/library/{id}，不经过 /player）',
  );
  const beginE = beginInputs[beginInputs.length - 1] as unknown as { source: unknown; draftSnapshot?: unknown };
  assert.deepStrictEqual(beginE.source, { kind: 'work', workId: WORK_ID }, 'E：begin 用 Work identity');
  assert.strictEqual(beginE.draftSnapshot, undefined, 'E：Work begin 不得带 client 快照');
  // 同 Work 断点 resume：保持 sessionId。
  const sessionE = sE.sessionId;
  ttsInputs.length = 0;
  playE.length = 0;
  useSession.setState({ nextParagraphIndex: 2, lastCompletedParagraphIndex: 1 });
  await getFlow().playWorkFromHistory(WORK_ID);
  assert.strictEqual(useSession.getState().sessionId, sessionE, 'E：同 Work 断点 resume 保持 sessionId');
  assert.strictEqual(ttsInputs[0], expectedParagraphs[2], 'E：同 Work 从 paragraphs[2] 继续');
  assert.strictEqual(beginInputs.length, 1, 'E：同 Work resume 不得 begin 新 Session');
  console.log('PASS: E history work session verified');

  // —— F：ended StoryCard → 正式 restart（新 sessionId，从 0 起播） ——
  console.log('--- F: ended card → restart with new session identity ---');
  resetPlaybackWorld();
  const playF: string[] = [];
  const atPlayF: SessionAtPlay[] = [];
  installSessionGuardedController(playF, atPlayF);
  seedLegacyCardMessage(MSG_F, STORY_TEXT, '');
  useSession.getState().setActiveStory({
    source: { kind: 'draft', messageId: MSG_F },
    sessionId: SESSION_F,
    title: '小松鼠的故事',
    storyText: STORY_TEXT,
    voiceId: 'alloy',
    speed: 1,
  });
  useSession.setState({ nextParagraphIndex: 4, status: 'ended' });
  await getFlow().playStoryCard({ messageId: MSG_F, storyText: STORY_TEXT });
  const sF = useSession.getState();
  assert.notStrictEqual(sF.sessionId, SESSION_F, 'F：ended 重播走正式 restart，新建 server session（新 sessionId）');
  assert.strictEqual(sF.nextParagraphIndex, 0, 'F：restart 从 paragraphs[0] 起播（ended 后无“续播”位）');
  assert.strictEqual(ttsInputs.length, 1);
  assert.strictEqual(ttsInputs[0], expectedParagraphs[0], 'F：重播合成 paragraphs[0]');
  assert.strictEqual(playF.length, 1);
  assert.strictEqual(atPlayF.length, 1, 'F：play 时 Session 先在');
  console.log('PASS: F ended restart verified');

  // —— G：同卡播放中 → 正式 pause（sessionId 不变，无新合成） ——
  console.log('--- G: same card playing → formal pause ---');
  resetPlaybackWorld();
  const playG: string[] = [];
  const atPlayG: SessionAtPlay[] = [];
  installSessionGuardedController(playG, atPlayG);
  seedLegacyCardMessage(MSG_G, STORY_TEXT, '');
  useSession.getState().setActiveStory({
    source: { kind: 'draft', messageId: MSG_G },
    sessionId: SESSION_G,
    title: '小松鼠的故事',
    storyText: STORY_TEXT,
    voiceId: 'alloy',
    speed: 1,
  });
  useSession.setState({ status: 'playing', nextParagraphIndex: 1 });
  useTransport.setState({ isPlaying: true });
  await getFlow().playStoryCard({ messageId: MSG_G, storyText: STORY_TEXT });
  assert.strictEqual(useSession.getState().sessionId, SESSION_G, 'G：pause 不得换 session');
  assert.strictEqual(useSession.getState().status, 'paused', 'G：正式 pause 落 paused');
  assert.strictEqual(ttsInputs.length, 0, 'G：pause 不得触发任何合成');
  assert.strictEqual(playG.length, 0, 'G：pause 不得起播');
  console.log('PASS: G same-card pause verified');

  // —— H：全入口静态审计（产品 playAudio 调用点 ⊆ SessionStore） ——
  console.log('--- H: static audit of all playback entries ---');
  const readCode = (rel: string): string =>
    stripComments(fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8'));

  const storyFlowCode = readCode('app/services/storyFlow.ts');
  assert.ok(!storyFlowCode.includes('playAudio('), 'H：storyFlow 不得再直接调用 playAudio');
  assert.ok(!storyFlowCode.includes('fetchAudio('), 'H：storyFlow 不得再直接合成 TTS');
  for (const dead of ['startStoryPlayback(', 'replayGeneration(', 'playStoryText(', 'synthesizeAndPlayOnce(']) {
    assert.ok(!storyFlowCode.includes(dead), `H：storyFlow dead 入口必须删除：${dead}`);
  }

  const chatLayoutCode = readCode('app/(main)/chat/components/ChatLayout/index.tsx');
  assert.ok(!chatLayoutCode.includes('playAudio'), 'H：ChatLayout 不得持有 Transport 播放 ownership');
  assert.ok(!chatLayoutCode.includes('onPlayStory'), 'H：ChatLayout 不得再透传 onPlayStory');

  for (const rel of [
    'app/(main)/chat/components/ChatLayout/MessageArea.tsx',
    'app/(main)/chat/components/ChatLog/ChatLog.tsx',
    'app/(main)/chat/components/ChatLog/MessageBubble/index.tsx',
    'app/(main)/chat/components/ChatLog/types.ts',
    'app/(main)/chat/components/MessageParts/index.tsx',
  ]) {
    assert.ok(!readCode(rel).includes('onPlayStory'), `H：onPlayStory 链必须整体删除：${rel}`);
  }

  const cardCode = readCode('app/(main)/chat/components/MessageParts/StoryCardPart.tsx');
  assert.ok(!cardCode.includes('onPlayStory'), 'H：StoryCard 不得再消费 Transport shortcut');
  assert.ok(!cardCode.includes('playStoryText('), 'H：StoryCard 不得再走 storyFlow 合成');
  assert.ok(!cardCode.includes('services/storyFlow'), 'H：StoryCard 不得再 import storyFlow');
  assert.ok(cardCode.includes('playStoryCard'), 'H：StoryCard 经 Flow 正式入口播放');

  const chatFlowCode = readCode('app/services/chatFlow.ts');
  assert.ok(!chatFlowCode.includes('startStoryPlayback('), 'H：autoplay 不得再走无 Session 起播');
  assert.ok(chatFlowCode.includes('autoplayDraftStory('), 'H：autoplay 经 Flow 正式入口');

  // 产品代码 playAudio 调用点 ⊆ SessionStore（Session/Flow 之外的业务 UI 不得直调 Transport 播放）。
  const prodRoots = ['app', 'components', 'stores'];
  const playAudioCallers: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (stripComments(fs.readFileSync(full, 'utf8')).includes('.playAudio(')) {
        playAudioCallers.push(path.relative(process.cwd(), full));
      }
    }
  };
  for (const root of prodRoots) walk(path.resolve(process.cwd(), root));
  assert.deepStrictEqual(
    playAudioCallers,
    ['stores/playbackSessionStore.ts'],
    `H：产品 playAudio 调用点必须收敛到 SessionStore，实际：${playAudioCallers.join(', ')}`,
  );
  console.log('PASS: H static audit verified');

  resetPlaybackWorld();
  console.log('\nALL STORYCARD SESSION FLOW TESTS PASSED!');
}

const testPromise = runStorycardSessionFlowTests()
  .then(() => {
    console.log('ALL STORYCARD SESSION FLOW TESTS PASSED!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;