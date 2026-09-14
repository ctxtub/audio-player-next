import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { installGlassToastStub, createToastCapture } from '../../support/mocks/ui-state.mock';
import { setupIsolatedDb } from '../../support/db/isolated-db.helper';
import { buildFakeCanonicalMp3 } from '../../support/fixtures/fake-canonical-mp3';
import { ensureStoryAudioSegmentForSubject } from '../../../lib/server/storyAudio';
import { getAudioProjectionsForSubject, listStoryWorksForSubject, getStoryWorkForSubject } from '../../../lib/server/storyWork';
import { resetAudioAssetStorageForTests } from '../../../lib/audio/storage/index';
import { resetCache } from '../../../lib/server/openai';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
installGlassToastStub(createToastCapture());

// 中文注释：Node 22 自带 navigator 且 onLine 为 undefined；store prefetch 的
// offline 守卫（`typeof navigator !== 'undefined' && !navigator.onLine`）在 node
// 下恒 early-return。测试进程内桩 onLine=true（browser 真机不受影响）。
try {
  const existingNav = (globalThis as { navigator?: unknown }).navigator as
    | Record<string, unknown>
    | undefined;
  if (existingNav && typeof existingNav === 'object') {
    Object.defineProperty(globalThis, 'navigator', {
      value: { ...existingNav, onLine: true },
      configurable: true,
      writable: true,
    });
  }
} catch {
  // 桩失败则 prefetch 相关断言会显式失败，不静默。
}

let ensureCalls = 0;
let ensureLog: Array<{ workId: number; segmentIndex: number; sessionId: string }> = [];
let fetchCalls = 0;
let mockTtsCount = 0;
const mockReadyMap = new Map<string, string>();
const ensureQueue: Array<() => Promise<never>> = [];

function mockEnsureDefault(input: { workId: number; segmentIndex: number; sessionId: string }) {
  ensureCalls += 1;
  ensureLog.push({ ...input });
  const key = `${input.workId}:${input.segmentIndex}`;
  const hit = mockReadyMap.get(key);
  if (hit) return Promise.resolve({ status: 'ready' as const, segment: { playbackUrl: hit } });
  mockTtsCount += 1;
  const url = `/api/audio/segments/mock-${input.workId}-${input.segmentIndex}`;
  mockReadyMap.set(key, url);
  return Promise.resolve({ status: 'ready' as const, segment: { playbackUrl: url } });
}

const ttsPath = path.resolve(process.cwd(), 'lib/client/ttsGenerate.ts');
const storyAudioPath = path.resolve(process.cwd(), 'lib/client/storyAudio.ts');
const ppPath = path.resolve(process.cwd(), 'lib/client/playbackSession.ts');
// 中文注释：promotion 桩处理器（B5 设置；其余阶段保持 null，误调用即显式失败）。
// 须在 store 求值前预置（ES import 编译期绑定，事后 patch 无效）。
let promoteHandler: ((input: { sessionId: string; workId: number }) => Promise<{
  title: string; contentHash: string; segmentationVersion: string;
  totalParagraphs: number; voiceId: string; speed: number;
}>) | null = null;
function installStubs() {
  nodeRequire.cache[ttsPath] = {
    id: ttsPath, filename: ttsPath, loaded: true,
    exports: { fetchAudio: async (): Promise<string> => { fetchCalls += 1; return `blob:mock-${fetchCalls}`; } },
  } as unknown as NodeModule;
  nodeRequire.cache[storyAudioPath] = {
    id: storyAudioPath, filename: storyAudioPath, loaded: true,
    exports: {
      getPlaybackManifest: async () => null,
      ensureSegment: async (input: { workId: number; segmentIndex: number; sessionId: string }) => {
        const q = ensureQueue.shift();
        if (q) return q() as never;
        return mockEnsureDefault(input);
      },
      shouldUseCanonicalAudio: (source: { kind: string } | null) => {
        if (!source || source.kind !== 'work') return false;
        try {
          return process.env.CANONICAL_AUDIO_ENABLED === '1' || process.env.NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED === '1';
        } catch { return false; }
      },
      selectWorkParagraphs: (local: string[], m: { segments: Array<{ index: number; text: string }> } | null) => {
        if (!m || !Array.isArray(m.segments) || m.segments.length === 0) return local;
        return [...m.segments].sort((a, b) => a.index - b.index).map((s) => s.text);
      },
      isCanonicalPlaybackUrl: (url: string) => typeof url === 'string' && url.startsWith('/api/audio/segments/'),
    },
  } as unknown as NodeModule;
  // 真实 playbackSession 模块仅覆盖 promote（其余委托真实实现；本文件不调用其他 server 动作）。
  // 注意：必须原地变异同一 exports 对象（jiti 编译产物可能已持有该对象引用，
  // 替换 cache 条目无法改写已加载模块的引用）。
  const realPP = nodeRequire(ppPath) as Record<string, unknown>;
  const realPromote = realPP['promoteDraftPlaybackToWork'];
  realPP['promoteDraftPlaybackToWork'] = async (input: { sessionId: string; workId: number }) => {
    if (!promoteHandler) throw new Error('unexpected promoteDraftPlaybackToWork call');
    return promoteHandler(input);
  };
  void realPromote;
}
installStubs();

const getSession = () => (nodeRequire('../../../stores/playbackSessionStore') as typeof import('../../../stores/playbackSessionStore')).usePlaybackSessionStore;
const getTransport = () => (nodeRequire('../../../stores/playbackStore') as typeof import('../../../stores/playbackStore')).usePlaybackStore;
const getConfig = () => (nodeRequire('../../../stores/configStore') as typeof import('../../../stores/configStore')).useConfigStore;

const SID_A = 'a47ac10b-58cc-4372-a567-0e02b2c3d47a';
const SID_B = 'b47ac10b-58cc-4372-a567-0e02b2c3d47b';
const P1 = `第一自然段：很久很久以前在宁静的大森林深处住着一只聪明活泼的小松鼠它有一条蓬松柔软的大尾巴每天清晨都在高高的树梢之间欢快地跳来跳去寻找新鲜的坚果与甘甜的露水日子过得无忧无虑。`;
const P2 = `第二自然段：小松鼠每天迎着金色的朝阳出门收集松果仔细辨别每一颗果实是否饱满香甜然后整整齐齐存放在自己温暖干燥的树洞深处为即将到来的漫长寒冬储备充足的粮食心里充满了丰收的喜悦。`;
const TWO = `${P1}\n${P2}`;

function resetWorld() {
  const { __resetPlaybackSessionTestHooks } = nodeRequire('../../../stores/playbackSessionStore') as typeof import('../../../stores/playbackSessionStore');
  __resetPlaybackSessionTestHooks();
  getSession().getState().reset();
  getTransport().getState().reset();
  getTransport().setState({ _tickIntervalId: null, _lastTickAt: null, isPlaying: false } as never);
  ensureCalls = 0; ensureLog = []; fetchCalls = 0; mockTtsCount = 0;
  mockReadyMap.clear(); ensureQueue.length = 0;
}
function fakeController(calls: string[]) {
  getTransport().getState().registerAudioController({
    unlock: async () => {}, play: async (u: string) => { calls.push(u); },
    resume: async () => {}, pause: () => {}, seek: () => {}, setPlaybackRate: () => {},
  });
}
function defer<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
/**
 * M8-04 集成：server 复用 + store provider（fake TTS + 隔离库）。
 */
async function runTests() {
  const savedFlag = process.env.CANONICAL_AUDIO_ENABLED;
  process.env.CANONICAL_AUDIO_ENABLED = '1';
  const { prisma } = await setupIsolatedDb('audio-work-reuse');
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm804-'));
  const keep = { root: process.env.AUDIO_LOCAL_ROOT, drv: process.env.AUDIO_STORAGE_DRIVER, vl: process.env.OPENAI_TTS_VOICE_LIST, v: process.env.OPENAI_TTS_DEFAULT_VOICE, m: process.env.OPENAI_TTS_MODEL, b: process.env.TTS_BACKEND_ID };
  process.env.AUDIO_STORAGE_DRIVER = 'local';
  process.env.AUDIO_LOCAL_ROOT = tmpRoot;
  process.env.OPENAI_TTS_VOICE_LIST = JSON.stringify([
    { value: 'alloy', label: 'Alloy' },
    { value: 'nova', label: 'Nova' },
  ]);
  process.env.OPENAI_TTS_DEFAULT_VOICE = 'alloy';
  process.env.OPENAI_TTS_MODEL = 'tts-1';
  process.env.TTS_BACKEND_ID = 'openai';
  resetCache(); resetAudioAssetStorageForTests();
  try {
    console.log('=== A1. 首次 TTS=1 → 重播仍 1；lookahead 仅+1；speed 恒 1.0 ===');
    const fake = { count: 0, speeds: [] as number[] };
    const synth = async (i: { text: string; model: string; voiceId: string; speed: number; format: string }) => {
      fake.count += 1; fake.speeds.push(i.speed);
      const b = buildFakeCanonicalMp3(10, fake.count);
      return { audioData: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, requestId: '' };
    };
    const user = await prisma.user.create({ data: { username: `m804_${Date.now()}`, password: 'TestPassword123!', nickname: 'M' } });
    const subject = { type: 'user' as const, id: user.id };
    const work = await prisma.storyWork.create({ data: { userId: user.id, prompt: 'p', storyText: TWO, voiceId: 'alloy', title: 't', excerpt: 'e', contentHash: '', sourceMessageId: null } });
    const { computeStoryContentHash } = await import('../../../utils/segmentation');
    await prisma.storyWork.update({ where: { id: work.id }, data: { contentHash: computeStoryContentHash(TWO) } });
    const r1 = await ensureStoryAudioSegmentForSubject(subject, { workId: work.id, segmentIndex: 0, sessionId: SID_A }, { synthesize: synth });
    assert.strictEqual(r1.status, 'ready'); assert.strictEqual(fake.count, 1);
    assert.ok(r1.status === 'ready' && r1.segment.playbackUrl.startsWith('/api/audio/segments/'));
    const r1b = await ensureStoryAudioSegmentForSubject(subject, { workId: work.id, segmentIndex: 0, sessionId: SID_A }, { synthesize: synth });
    assert.strictEqual(r1b.status, 'ready'); assert.strictEqual(fake.count, 1, '重播 TTS 仍 1');
    const r2 = await ensureStoryAudioSegmentForSubject(subject, { workId: work.id, segmentIndex: 1, sessionId: SID_A }, { synthesize: synth });
    assert.strictEqual(r2.status, 'ready'); assert.strictEqual(fake.count, 2, 'lookahead 仅+1');
    assert.deepStrictEqual(fake.speeds, [1.0, 1.0], 'speed 恒 1.0');
    console.log('=== A2. 投影 ready+duration ===');
    const list = await listStoryWorksForSubject(subject, { view: 'active', limit: 10 });
    const item = list.items.find((i) => i.id === work.id);
    assert.ok(item); assert.strictEqual(item!.audio.status, 'ready');
    assert.ok(typeof item!.audio.durationMs === 'number' && (item!.audio.durationMs as number) > 0);
    const detail = await getStoryWorkForSubject(subject, work.id);
    assert.strictEqual(detail.audio.status, 'ready');
    const pmap = await getAudioProjectionsForSubject(subject, [work.id, 999999]);
    assert.ok(pmap.has(work.id) && !pmap.has(999999));
    console.log('PASS: A 通过');
    console.log('=== B1. 首播 ensure → 重播无额外 TTS ===');
    resetWorld();
    const pc1: string[] = []; fakeController(pc1);
    getConfig().setState({ apiConfig: { ...getConfig().getState().apiConfig, voiceId: 'alloy', speed: 1 } });
    getSession().getState().setActiveStory({ source: { kind: 'work', workId: work.id }, sessionId: SID_A, title: 't', storyText: TWO, voiceId: 'alloy', speed: 1.0 });
    getTransport().setState({ isPlaying: true } as never);
    await getSession().getState().playParagraph(0, { explicit: true });
    assert.strictEqual(ensureCalls, 1); assert.strictEqual(fetchCalls, 0);
    assert.ok(pc1[0]?.startsWith('/api/audio/segments/'));
    const t0 = mockTtsCount;
    await getSession().getState().playParagraph(0, { explicit: true });
    assert.strictEqual(mockTtsCount, t0, '重播无额外 TTS');
    console.log('=== B2. pause/resume + 路由连续 ===');
    resetWorld(); fakeController(pc1);
    getSession().getState().setActiveStory({ source: { kind: 'work', workId: work.id }, sessionId: SID_A, title: 't', storyText: TWO, voiceId: 'alloy', speed: 1.0 });
    getTransport().setState({ isPlaying: true } as never);
    await getSession().getState().playParagraph(0, { explicit: true });
    await getSession().getState().prefetchNextParagraph(1);
    assert.strictEqual(mockTtsCount, 2);
    getSession().getState().handleExplicitPause();
    getTransport().setState({ isPlaying: true } as never);
    await getSession().getState().playParagraph(1, { explicit: true });
    assert.strictEqual(mockTtsCount, 2, 'resume 命中预取');
    const sid = getSession().getState().sessionId;
    await getSession().getState().playParagraph(0, { explicit: true });
    assert.strictEqual(getSession().getState().sessionId, sid);
    assert.strictEqual(mockTtsCount, 2, '路由连续无额外 TTS');
    console.log('=== B3. 水合 hit ===');
    resetWorld(); fakeController(pc1);
    getSession().getState().setActiveStory({ source: { kind: 'work', workId: work.id }, sessionId: SID_A, title: 't', storyText: TWO, voiceId: 'alloy', speed: 1.0 });
    getTransport().setState({ isPlaying: true } as never);
    await getSession().getState().playParagraph(0, { explicit: true });
    assert.strictEqual(mockTtsCount, 1);
    const anchor = { sessionId: SID_A, source: { kind: 'work' as const, workId: work.id }, title: 't', contentHash: getSession().getState().contentHash, segmentationVersion: 'v1', nextParagraphIndex: 0, lastCompletedParagraphIndex: -1, voiceId: 'alloy', speed: 1.0, sleepTimerMode: 'off' as const, remainingAllowedMs: null, totalAllowedMs: null };
    const hooks = nodeRequire('../../../stores/playbackSessionStore') as typeof import('../../../stores/playbackSessionStore');
    hooks.__resetPlaybackSessionTestHooks();
    getSession().getState().reset(); getTransport().getState().reset(); fakeController(pc1);
    const ok = await getSession().getState().hydrateFromAnchor(anchor as never, {
      getWork: async () => ({ title: 't', storyText: TWO, voiceId: 'alloy', contentHash: anchor.contentHash }),
      getManifest: async () => ({ segments: [{ index: 0, text: P1 }, { index: 1, text: P2 }], segmentationVersion: 'v1' }),
    });
    assert.strictEqual(ok, true); assert.strictEqual(getSession().getState().status, 'ready');
    getTransport().setState({ isPlaying: true } as never);
    const tb = mockTtsCount;
    await getSession().getState().playParagraph(0, { explicit: true });
    assert.strictEqual(mockTtsCount, tb, '水合后 hit');
    console.log('=== B4. speed1.5 仍 canonical；Draft 旧路径 ===');
    resetWorld(); fakeController(pc1);
    getSession().getState().setActiveStory({ source: { kind: 'work', workId: work.id }, sessionId: SID_A, title: 't', storyText: TWO, voiceId: 'alloy', speed: 1.5 });
    getTransport().setState({ isPlaying: true } as never);
    await getSession().getState().playParagraph(0, { explicit: true });
    assert.strictEqual(fetchCalls, 0);
    assert.ok(ensureLog.every((e) => !('speed' in e)));
    resetWorld(); fakeController(pc1);
    getSession().getState().setActiveStory({ source: { kind: 'draft', messageId: 'd1' }, sessionId: SID_B, title: '草稿', storyText: TWO, voiceId: 'alloy', speed: 1.0 });
    getTransport().setState({ isPlaying: true } as never);
    await getSession().getState().playParagraph(0, { explicit: true });
    assert.strictEqual(fetchCalls, 1); assert.strictEqual(ensureCalls, 0, 'Draft 不走 ensure');
    console.log('=== B5. promotion 不打断 ===');
    resetWorld(); fakeController(pc1);
    getSession().getState().setActiveStory({ source: { kind: 'draft', messageId: 'd1' }, sessionId: SID_B, title: '草稿', storyText: TWO, voiceId: 'alloy', speed: 1.0 });
    getTransport().setState({ isPlaying: true } as never);
    await getSession().getState().playParagraph(0, { explicit: true });
    const draftUrl = getTransport().getState().currentAudioUrl;
    assert.ok(typeof draftUrl === 'string' && draftUrl.startsWith('blob:'));
    promoteHandler = async () => ({ title: 't', contentHash: getSession().getState().contentHash, segmentationVersion: 'v1', totalParagraphs: 2, voiceId: 'alloy', speed: 1.0 });
    await getSession().getState().promoteDraftToWork(work.id);
    assert.strictEqual(getSession().getState().source?.kind, 'work');
    assert.strictEqual(getTransport().getState().currentAudioUrl, draftUrl, '当前 Blob 不被打断');
    getTransport().setState({ isPlaying: true } as never);
    const eb = ensureCalls;
    await getSession().getState().playParagraph(1, { explicit: true });
    assert.ok(ensureCalls > eb, '后续 Work 段走 canonical');
    promoteHandler = null;
    console.log('=== B6. stale 丢弃 + lookahead=1 ===');
    resetWorld(); fakeController(pc1);
    getSession().getState().setActiveStory({ source: { kind: 'work', workId: work.id }, sessionId: SID_A, title: 't', storyText: TWO, voiceId: 'alloy', speed: 1.0 });
    getTransport().setState({ isPlaying: true } as never);
    const gate = defer<{ status: 'ready'; segment: { playbackUrl: string } }>();
    ensureQueue.push(() => gate.promise as unknown as Promise<never>);
    const pendingA = getSession().getState().playParagraph(0, { explicit: true });
    getSession().setState({ sessionId: SID_B });
    gate.resolve({ status: 'ready', segment: { playbackUrl: '/api/audio/segments/stale-A' } });
    await pendingA;
    assert.ok(!pc1.includes('/api/audio/segments/stale-A'), 'stale A 绝不播放');
    resetWorld(); fakeController(pc1);
    getSession().getState().setActiveStory({ source: { kind: 'work', workId: work.id }, sessionId: SID_A, title: 't', storyText: TWO, voiceId: 'alloy', speed: 1.0 });
    getTransport().setState({ isPlaying: true } as never);
    const before = ensureCalls;
    await getSession().getState().prefetchNextParagraph(99);
    assert.strictEqual(ensureCalls, before, '越界/非+1 不预取');
    console.log('\nALL WORK PLAYBACK REUSE INTEGRATION TESTS PASSED!');
  } finally {
    if (savedFlag === undefined) delete process.env.CANONICAL_AUDIO_ENABLED;
    else process.env.CANONICAL_AUDIO_ENABLED = savedFlag;
    if (keep.root === undefined) delete process.env.AUDIO_LOCAL_ROOT; else process.env.AUDIO_LOCAL_ROOT = keep.root;
    if (keep.drv === undefined) delete process.env.AUDIO_STORAGE_DRIVER; else process.env.AUDIO_STORAGE_DRIVER = keep.drv;
    if (keep.vl === undefined) delete process.env.OPENAI_TTS_VOICE_LIST; else process.env.OPENAI_TTS_VOICE_LIST = keep.vl;
    if (keep.v === undefined) delete process.env.OPENAI_TTS_DEFAULT_VOICE; else process.env.OPENAI_TTS_DEFAULT_VOICE = keep.v;
    if (keep.m === undefined) delete process.env.OPENAI_TTS_MODEL; else process.env.OPENAI_TTS_MODEL = keep.m;
    if (keep.b === undefined) delete process.env.TTS_BACKEND_ID; else process.env.TTS_BACKEND_ID = keep.b;
    resetCache(); resetAudioAssetStorageForTests();
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

const testPromise = runTests()
  .then(() => { console.log('ALL WORK PLAYBACK REUSE INTEGRATION TESTS PASSED!'); })
  .catch((err) => { console.error('Test failed:', err); process.exit(1); });

export default testPromise;

