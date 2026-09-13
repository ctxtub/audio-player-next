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
import {
  decideRehydratedPosition,
  isRehydrateTransportIdle,
  resolveRehydratedTitle,
  REHYDRATE_TRANSPORT_IDLE,
} from '../../../lib/playback/rehydrate';
import { rehydratedContinuationMode } from '../../../lib/playback/progress';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const toastCapture = createToastCapture();
installGlassToastStub(toastCapture);

// Session / transport / history stores 经 require 懒取（须在 GlassToast 打桩之后）。
const getSessionStore = () => {
  const mod = nodeRequire('../../../stores/playbackSessionStore') as typeof import('../../../stores/playbackSessionStore');
  return mod.usePlaybackSessionStore;
};
const getTransportStore = () => {
  const mod = nodeRequire('../../../stores/playbackStore') as typeof import('../../../stores/playbackStore');
  return mod.usePlaybackStore;
};
const getHistoryStore = () => {
  const mod = nodeRequire('../../../stores/generationHistoryStore') as typeof import('../../../stores/generationHistoryStore');
  return mod.useGenerationHistoryStore;
};

/**
 * M5-09 Client Session SSOT / Rehydrate 单元测试（L1，§25 系列本范围部分）。
 * 覆盖：Work/Draft 双路径 + hash reset + title 更新不重置 +
 * legacy store 残留不破坏新流程 + transport idle + continuation finite。
 * 纯内存 + 注入 fake resolvers，不触库、不调网络（unit 禁 lib/db 由 runner 静态扫描保证）。
 */

const VALID_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const STORY_4P = [
  '第一自然段：很久很久以前，在宁静的大森林深处住着一只聪明活泼的小松鼠，它有一条蓬松的大尾巴，每天清晨都在高高的树梢间欢快地跳来跳去，寻找新鲜的坚果与甘甜的露水。',
  '第二自然段：小松鼠每天早晨迎着金色的朝阳出门收集松果，仔细辨别每一颗果实是否饱满香甜，并将它们整齐地存放在自己温暖干燥的树洞深处，准备迎接即将到来的寒冷冬天。',
  '第三自然段：有一天它在一棵巨大的古老松树下发现了一颗闪闪发光的神奇松果，散发出奇异而温暖的柔和光芒，不仅照亮了周围湿漉漉的青苔，还散发出一种让人心情平静的香气。',
  '第四自然段：这颗发光的松果带领着好奇的小松鼠走进了森林最深处的奇妙花园，那里盛开着从未见过的美丽奇幻花朵，彩色的蝴蝶在花丛中翩翩起舞，宛如梦境一般美丽动人。',
].join('\n');

function buildAnchor(overrides: Record<string, unknown> = {}) {
  const normalized = normalizeStoryText(STORY_4P);
  const hash = computeStoryContentHash(normalized);
  const total = Math.max(1, segmentStoryText(normalized).length);
  return {
    sessionId: VALID_UUID,
    source: { kind: 'work', workId: 300 } as const,
    state: 'ready' as const,
    title: '小松鼠的故事',
    contentHash: hash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 1,
    nextParagraphIndex: 2,
    totalParagraphs: total,
    voiceId: 'alloy',
    speed: 1.0,
    remainingAllowedMs: null as number | null,
    totalAllowedMs: null as number | null,
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...overrides,
  };
}

async function runPlaybackSessionRehydrateTests(): Promise<void> {
  console.log('=== M5-09: Client Session Rehydrate (unit) ===');

  // —— §25.3 纯函数：hash 一致保留 / 不一致 reset 0 / version 变化 reset 0 ——
  console.log('--- §25.3 decideRehydratedPosition ---');
  const h1 = computeStoryContentHash(normalizeStoryText(STORY_4P));
  const h2 = computeStoryContentHash(normalizeStoryText(`${STORY_4P}\n尾声新段落`));
  assert.notStrictEqual(h1, h2, '篡改正文必须产生不同 hash');
  assert.deepStrictEqual(
    decideRehydratedPosition({
      savedNextParagraphIndex: 2,
      savedLastCompletedParagraphIndex: 1,
      savedContentHash: h1,
      savedSegmentationVersion: SEGMENTATION_VERSION,
      currentContentHash: h1,
      totalParagraphs: 4,
    }),
    { nextParagraphIndex: 2, lastCompletedParagraphIndex: 1, drifted: false },
  );
  assert.deepStrictEqual(
    decideRehydratedPosition({
      savedNextParagraphIndex: 2,
      savedLastCompletedParagraphIndex: 1,
      savedContentHash: h1,
      savedSegmentationVersion: SEGMENTATION_VERSION,
      currentContentHash: h2,
      totalParagraphs: 5,
    }),
    { nextParagraphIndex: 0, lastCompletedParagraphIndex: -1, drifted: true },
  );
  assert.deepStrictEqual(
    decideRehydratedPosition({
      savedNextParagraphIndex: 2,
      savedLastCompletedParagraphIndex: 1,
      savedContentHash: h1,
      savedSegmentationVersion: 'v0-legacy',
      currentContentHash: h1,
      totalParagraphs: 4,
    }),
    { nextParagraphIndex: 0, lastCompletedParagraphIndex: -1, drifted: true },
  );
  // 越界钳制（保留旧 hydrateFromDTO 语义：next>=total → total-1）。
  assert.deepStrictEqual(
    decideRehydratedPosition({
      savedNextParagraphIndex: 99,
      savedLastCompletedParagraphIndex: 98,
      savedContentHash: h1,
      savedSegmentationVersion: SEGMENTATION_VERSION,
      currentContentHash: h1,
      totalParagraphs: 4,
    }),
    { nextParagraphIndex: 3, lastCompletedParagraphIndex: 3, drifted: false },
  );
  console.log('PASS: hash validation verified');

  // —— §25.4 纯函数：title 变化只更新 title（调用方不得重置 position） ——
  console.log('--- §25.4 resolveRehydratedTitle ---');
  assert.strictEqual(resolveRehydratedTitle('A', 'B'), 'B');
  assert.strictEqual(resolveRehydratedTitle('A', 'A'), 'A');
  assert.strictEqual(resolveRehydratedTitle('A', null), 'A');
  assert.strictEqual(resolveRehydratedTitle('A', ''), 'A');
  // title 变化不影响 position 决策（显式组合断言：drifted=false 且 next 保留）。
  const posWithRename = decideRehydratedPosition({
    savedNextParagraphIndex: 2,
    savedLastCompletedParagraphIndex: 1,
    savedContentHash: h1,
    savedSegmentationVersion: SEGMENTATION_VERSION,
    currentContentHash: h1,
    totalParagraphs: 4,
  });
  assert.strictEqual(posWithRename.drifted, false);
  assert.strictEqual(posWithRename.nextParagraphIndex, 2);
  assert.strictEqual(resolveRehydratedTitle('旧标题', '新标题'), '新标题');
  console.log('PASS: title update without reset verified');

  // —— §25.5 transport idle 断言 ——
  console.log('--- §25.5 isRehydrateTransportIdle ---');
  assert.strictEqual(
    isRehydrateTransportIdle({ isPlaying: false, audioUrl: null, currentTime: 0, duration: 0 }),
    true,
  );
  assert.strictEqual(
    isRehydrateTransportIdle({ isPlaying: true, audioUrl: null, currentTime: 0, duration: 0 }),
    false,
  );
  assert.strictEqual(
    isRehydrateTransportIdle({ isPlaying: false, audioUrl: 'blob:x', currentTime: 0, duration: 0 }),
    false,
  );
  assert.deepStrictEqual({ ...REHYDRATE_TRANSPORT_IDLE }, {
    isPlaying: false,
    audioUrl: null,
    currentTime: 0,
    duration: 0,
  });
  // rehydrate 后一律 finite（§12）。
  assert.strictEqual(rehydratedContinuationMode(), 'finite');
  console.log('PASS: transport idle verified');

  // —— 新 SSOT 不走旧路径（源码级 cutover 断言：检查真实 import，而非注释提及） ——
  console.log('--- legacy cutover: no generationHistoryStore in new SSOT ---');
  const sessionSource = fs.readFileSync(
    path.resolve(process.cwd(), 'stores/playbackSessionStore.ts'),
    'utf8',
  );
  assert(
    !sessionSource.includes("from '@/stores/generationHistoryStore'") &&
      !sessionSource.includes('from "@/stores/generationHistoryStore"') &&
      !sessionSource.includes('useGenerationHistoryStore(') &&
      !sessionSource.includes("from '@/stores/playbackProgressStore'") &&
      !sessionSource.includes("from '@/app/services/storyFlow'"),
    'PlaybackSessionStore 严禁 import 旧路径（§25.1）',
  );
  const hostSource = fs.readFileSync(
    path.resolve(process.cwd(), 'components/AudioControllerHost/index.tsx'),
    'utf8',
  );
  assert(!hostSource.includes("from '@/stores/chatStore'"), 'Host 不得直接 import ChatStore（§26.1）');
  assert(!hostSource.includes("from '@/stores/preloadStore'"), 'Host 不得直接 import PreloadStore（§26.1）');
  assert(
    !hostSource.includes("from '@/stores/playbackProgressStore'"),
    'Host 不得直接 import PlaybackProgressStore（§26.1）',
  );
  assert(!hostSource.includes("from '@/app/services/storyFlow'"), 'Host 不得直接 import storyFlow（§26.1）');
  assert(
    hostSource.includes('playbackSessionFlow'),
    'Host 必须经 PlaybackSessionFlow 报告事件（§26.1）',
  );
  console.log('PASS: legacy cutover source assertions verified');

  // —— Store 级：Work 双路径（精确 resolve + hash reset + title 更新 + transport idle） ——
  console.log('--- store: Work rehydrate precise resolve ---');
  const useSession = getSessionStore();
  const useTransport = getTransportStore();
  const { __resetPlaybackSessionTestHooks } = nodeRequire(
    '../../../stores/playbackSessionStore',
  ) as typeof import('../../../stores/playbackSessionStore');
  __resetPlaybackSessionTestHooks();
  useSession.getState().reset();
  useTransport.getState().reset();

  // legacy 残留：history store 仅有第一页，Anchor 指向第 300 条（远页）。
  const useHistory = getHistoryStore();
  useHistory.setState({
    records: [
      { id: 1, prompt: 'p1', storyText: 't1', voiceId: '', title: 't1', excerpt: '', contentHash: '', sourceMessageId: null, favoritedAt: null, deletedAt: null, createdAt: '', updatedAt: '' },
      { id: 2, prompt: 'p2', storyText: 't2', voiceId: '', title: 't2', excerpt: '', contentHash: '', sourceMessageId: null, favoritedAt: null, deletedAt: null, createdAt: '', updatedAt: '' },
    ] as unknown as ReturnType<typeof useHistory.getState>['records'],
    syncEnabled: true,
  });

  let cleared: string[] = [];
  let driftNotified = 0;
  const anchorWork = buildAnchor();
  const okWork = await useSession.getState().hydrateFromAnchor(anchorWork as never, {
    getWork: async (workId: number) => {
      assert.strictEqual(workId, 300, '必须按 workId 精确 resolve（§25.1），不得用 history find 猜');
      return { title: '小松鼠的故事', storyText: STORY_4P, voiceId: 'alloy', contentHash: h1 };
    },
    clearAnchor: async (sid: string) => {
      cleared.push(sid);
    },
    notifyDrift: () => {
      driftNotified += 1;
    },
  });
  assert.strictEqual(okWork, true);
  assert.strictEqual(cleared.length, 0, '成功水合不得清 Anchor');
  assert.strictEqual(driftNotified, 0, 'hash 一致不得 toast 漂移');
  const sWork = useSession.getState();
  assert.strictEqual(sWork.status, 'ready');
  assert.deepStrictEqual(sWork.source, { kind: 'work', workId: 300 });
  assert.strictEqual(sWork.nextParagraphIndex, 2, 'hash 一致须保留断点');
  assert.strictEqual(sWork.continuationMode, 'finite');
  const tWork = useTransport.getState();
  assert.strictEqual(
    isRehydrateTransportIdle({
      isPlaying: tWork.isPlaying,
      audioUrl: tWork.currentAudioUrl,
      currentTime: tWork.currentTime,
      duration: tWork.duration,
    }),
    true,
    '§25.5 transport 必须 idle 且不 autoplay',
  );
  console.log('PASS: Work precise resolve verified');

  // —— Store 级：hash 漂移 reset 0 ——
  console.log('--- store: hash drift resets to 0 ---');
  __resetPlaybackSessionTestHooks();
  useSession.getState().reset();
  useTransport.getState().reset();
  cleared = [];
  driftNotified = 0;
  const okDrift = await useSession.getState().hydrateFromAnchor(anchorWork as never, {
    getWork: async () => ({ title: '小松鼠的故事', storyText: `${STORY_4P}\n全新尾声段落`, voiceId: 'alloy', contentHash: h1 }),
    clearAnchor: async (sid: string) => {
      cleared.push(sid);
    },
    notifyDrift: () => {
      driftNotified += 1;
    },
  });
  assert.strictEqual(okDrift, true);
  assert.strictEqual(driftNotified, 1, '漂移必须 toast 提示');
  assert.strictEqual(useSession.getState().nextParagraphIndex, 0);
  assert.strictEqual(useSession.getState().lastCompletedParagraphIndex, -1);
  console.log('PASS: hash drift reset verified');

  // —— Store 级：title 变化更新 title 但不重置 ——
  console.log('--- store: title rename keeps position ---');
  __resetPlaybackSessionTestHooks();
  useSession.getState().reset();
  useTransport.getState().reset();
  const okRename = await useSession.getState().hydrateFromAnchor(anchorWork as never, {
    getWork: async () => ({ title: '重命名后的标题', storyText: STORY_4P, voiceId: 'alloy', contentHash: h1 }),
    clearAnchor: async () => {},
    notifyDrift: () => {
      assert.fail('title 变化不得触发漂移 toast');
    },
  });
  assert.strictEqual(okRename, true);
  assert.strictEqual(useSession.getState().title, '重命名后的标题');
  assert.strictEqual(useSession.getState().nextParagraphIndex, 2, 'title 变化不得重置 progress（§25.4）');
  assert.strictEqual(useTransport.getState().title, '重命名后的标题');
  console.log('PASS: title rename verified');

  // —— Store 级：Draft 双路径（成功 + dangling 清理） ——
  console.log('--- store: Draft rehydrate + dangling fail-closed ---');
  __resetPlaybackSessionTestHooks();
  useSession.getState().reset();
  useTransport.getState().reset();
  cleared = [];
  const draftAnchor = buildAnchor({
    source: { kind: 'draft', messageId: 'msg-draft-1' },
    title: '草稿故事',
  });
  const okDraft = await useSession.getState().hydrateFromAnchor(draftAnchor as never, {
    ensureChatLoaded: async () => {},
    findDraftStoryText: () => STORY_4P,
    clearAnchor: async (sid: string) => {
      cleared.push(sid);
    },
  });
  assert.strictEqual(okDraft, true);
  assert.deepStrictEqual(useSession.getState().source, { kind: 'draft', messageId: 'msg-draft-1' });
  assert.strictEqual(useSession.getState().status, 'ready');
  assert.strictEqual(useSession.getState().continuationMode, 'finite', 'rehydrated draft 一律 finite（§12）');

  __resetPlaybackSessionTestHooks();
  useSession.getState().reset();
  useTransport.getState().reset();
  cleared = [];
  const okDangling = await useSession.getState().hydrateFromAnchor(draftAnchor as never, {
    ensureChatLoaded: async () => {},
    findDraftStoryText: () => null,
    clearAnchor: async (sid: string) => {
      cleared.push(sid);
    },
  });
  assert.strictEqual(okDangling, false, 'Draft 正文缺失必须返回 false');
  assert.deepStrictEqual(cleared, [VALID_UUID], 'dangling 必须 best-effort 清 server Anchor（fail-closed）');
  assert.strictEqual(useSession.getState().status, 'idle');
  assert.strictEqual(useSession.getState().source, null);
  console.log('PASS: Draft rehydrate verified');

  // —— Store 级：Work missing → dangling 清理（trash/missing/foreign 统一 fail-closed） ——
  console.log('--- store: Work missing drops dangling ---');
  __resetPlaybackSessionTestHooks();
  useSession.getState().reset();
  useTransport.getState().reset();
  cleared = [];
  const okMissing = await useSession.getState().hydrateFromAnchor(anchorWork as never, {
    getWork: async () => {
      throw new Error('NOT_FOUND');
    },
    clearAnchor: async (sid: string) => {
      cleared.push(sid);
    },
  });
  assert.strictEqual(okMissing, false);
  assert.deepStrictEqual(cleared, [VALID_UUID]);
  assert.strictEqual(useSession.getState().source, null);
  console.log('PASS: Work missing fail-closed verified');

  console.log('\nALL M5-09 REHYDRATE UNIT TESTS PASSED!');
}

const testPromise = runPlaybackSessionRehydrateTests()
  .then(() => {
    console.log('ALL M5-09 REHYDRATE UNIT TESTS PASSED!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;
