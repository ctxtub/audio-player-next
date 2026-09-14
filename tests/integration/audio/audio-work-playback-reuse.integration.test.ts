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
import { beginPlaybackSessionForSubject, completePlaybackSessionForSubject, promoteDraftPlaybackToWorkForSubject, savePlaybackCheckpointForSubject } from '../../../lib/server/playbackSession';
import { SEGMENTATION_VERSION } from '../../../utils/segmentation';
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
const SID_C = 'c47ac10b-58cc-4372-a567-0e02b2c3d47c';
const SID_D = 'd47ac10b-58cc-4372-a567-0e02b2c3d47d';
const SID_E = 'e47ac10b-58cc-4372-a567-0e02b2c3d47e';
const SID_F = 'f47ac10b-58cc-4372-a567-0e02b2c3d47f';
const SID_G = '071ac10b-58cc-4372-a567-0e02b2c3d471';
const SID_H = '081ac10b-58cc-4372-a567-0e02b2c3d481';
const SID_I = '091ac10b-58cc-4372-a567-0e02b2c3d491';
const SID_J = '0a1ac10b-58cc-4372-a567-0e02b2c3d4a1';
const SID_K = '0b1ac10b-58cc-4372-a567-0e02b2c3d4b1';
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
    console.log('=== B7. Oracle A Blocking1 Manifest 权威（legacy-v0 不 reset） ===');
    assert.notStrictEqual(SEGMENTATION_VERSION, 'legacy-v0', '前提：全局版本须与 legacy 不同值');
    const workA = await prisma.storyWork.create({ data: { userId: user.id, prompt: 'oracleA', storyText: TWO, voiceId: 'alloy', title: 'oracleA', excerpt: 'e', contentHash: '', sourceMessageId: 'oracleA-m1' } });
    const { computeStoryContentHash: cchA } = await import('../../../utils/segmentation');
    const hashA = cchA(TWO);
    await prisma.storyWork.update({ where: { id: workA.id }, data: { contentHash: hashA } });
    const rA = await ensureStoryAudioSegmentForSubject(subject, { workId: workA.id, segmentIndex: 0, sessionId: SID_C }, { synthesize: synth });
    assert.strictEqual(rA.status, 'ready', 'oracleA manifest 先建');
    const manA = await prisma.storyAudioManifest.findUnique({ where: { storyWorkId_version: { storyWorkId: workA.id, version: 1 } } });
    assert.ok(manA, 'oracleA manifest 行存在');
    assert.strictEqual(manA!.segmentCount, 2, 'oracleA manifest segmentCount=2');
    await prisma.storyAudioManifest.update({ where: { id: manA!.id }, data: { segmentationVersion: 'legacy-v0' } });
    await prisma.storyPlaybackProgress.upsert({
      where: { storyWorkId: workA.id },
      create: { storyWorkId: workA.id, contentHash: hashA, segmentationVersion: 'legacy-v0', lastCompletedParagraphIndex: 0, nextParagraphIndex: 1, totalParagraphs: 2, completedAt: null, lastPlayedAt: new Date() },
      update: { contentHash: hashA, segmentationVersion: 'legacy-v0', lastCompletedParagraphIndex: 0, nextParagraphIndex: 1, totalParagraphs: 2 },
    });
    const anchorA = await beginPlaybackSessionForSubject(subject, { sessionId: SID_D, source: { kind: 'work', workId: workA.id }, mode: 'resume', speed: 1.0 });
    assert.strictEqual(anchorA.nextParagraphIndex, 1, 'Oracle A：begin resume 不 reset（Manifest 权威，legacy==legacy）');
    assert.strictEqual(anchorA.lastCompletedParagraphIndex, 0, 'Oracle A：last 保留 0');
    assert.strictEqual(anchorA.segmentationVersion, 'legacy-v0', "Oracle A：Anchor segmentationVersion='legacy-v0'");
    assert.strictEqual(anchorA.totalParagraphs, 2, 'Oracle A：totalParagraphs=Manifest.segmentCount');
    const progA = await prisma.storyPlaybackProgress.findUnique({ where: { storyWorkId: workA.id } });
    assert.strictEqual(progA?.segmentationVersion, 'legacy-v0', 'Oracle A：Progress 仍 legacy（未被改写为当前版本）');
    assert.strictEqual(progA?.nextParagraphIndex, 1, 'Oracle A：Progress 未推进/重置');
    resetWorld(); fakeController(pc1);
    const FROZEN_A = `${P1}【冻】`;
    const FROZEN_B = `${P2}【冻】`;
    const okA = await getSession().getState().hydrateFromAnchor(anchorA as never, {
      getWork: async () => ({ title: 'oracleA', storyText: TWO, voiceId: 'alloy', contentHash: hashA }),
      getManifest: async () => ({ segments: [{ index: 0, text: FROZEN_A }, { index: 1, text: FROZEN_B }], segmentationVersion: 'legacy-v0', segmentCount: 2 }),
    });
    assert.strictEqual(okA, true, 'Oracle A：hydrate 成功');
    assert.strictEqual(getSession().getState().status, 'ready', 'Oracle A：hydrate 进入 ready');
    assert.deepStrictEqual(getSession().getState().paragraphs, [FROZEN_A, FROZEN_B], 'Oracle A：hydrate paragraphs=frozen text');
    assert.strictEqual(getSession().getState().nextParagraphIndex, 1, 'Oracle A：hydrate next 仍 1');
    assert.strictEqual(getSession().getState().segmentationVersion, 'legacy-v0', 'Oracle A：hydrate version 仍 legacy');
    assert.strictEqual(getSession().getState().totalParagraphs, 2, 'Oracle A：hydrate total=Manifest.segmentCount');
    console.log('=== B8. Oracle B Blocking2 读失败 fail-closed（不 fallback/可 retry） ===');
    resetWorld(); fakeController(pc1);
    let clearCalls = 0;
    const anchorB = { sessionId: SID_C, source: { kind: 'work' as const, workId: workA.id }, title: 'oracleA', contentHash: hashA, segmentationVersion: 'legacy-v0', nextParagraphIndex: 1, lastCompletedParagraphIndex: 0, totalParagraphs: 2, voiceId: 'alloy', speed: 1.0, sleepTimerMode: 'off' as const, remainingAllowedMs: null, totalAllowedMs: null };
    const okB0 = await getSession().getState().hydrateFromAnchor(anchorB as never, {
      getWork: async () => ({ title: 'oracleA', storyText: TWO, voiceId: 'alloy', contentHash: hashA }),
      getManifest: async () => ({ segments: [{ index: 0, text: FROZEN_A }, { index: 1, text: FROZEN_B }], segmentationVersion: 'legacy-v0', segmentCount: 2 }),
      clearAnchor: async () => { clearCalls += 1; return { cleared: true }; },
    });
    assert.strictEqual(okB0, true, 'Oracle B 前提：先成功水合 legacy');
    const keptParagraphs = [...getSession().getState().paragraphs];
    const keptVersion = getSession().getState().segmentationVersion;
    const progBefore = await prisma.storyPlaybackProgress.findUnique({ where: { storyWorkId: workA.id } });
    hooks.__resetPlaybackSessionTestHooks();
    const okB = await getSession().getState().hydrateFromAnchor(anchorB as never, {
      getWork: async () => ({ title: 'oracleA', storyText: TWO, voiceId: 'alloy', contentHash: hashA }),
      getManifest: async () => { throw new Error('manifest-fetch-boom'); },
      clearAnchor: async () => { clearCalls += 1; return { cleared: true }; },
    });
    assert.strictEqual(okB, false, 'Oracle B：hydrate 读失败返回 false');
    assert.notStrictEqual(getSession().getState().status, 'ready', 'Oracle B：不进入 ready');
    assert.strictEqual(getSession().getState().status, 'error', 'Oracle B：fail-closed 置 error（可 retry）');
    assert.deepStrictEqual(getSession().getState().paragraphs, keptParagraphs, 'Oracle B：不得把 local paragraphs 当 canonical SSOT');
    assert.strictEqual(getSession().getState().segmentationVersion, keptVersion, 'Oracle B：不得改写 segmentationVersion 为当前版本');
    assert.ok(!getSession().getState().paragraphs.includes(P1) || getSession().getState().paragraphs.includes('【冻】'), 'Oracle B：paragraphs 仍 frozen 非本地回落');
    const progAfter = await prisma.storyPlaybackProgress.findUnique({ where: { storyWorkId: workA.id } });
    assert.deepStrictEqual({ next: progAfter?.nextParagraphIndex, last: progAfter?.lastCompletedParagraphIndex, ver: progAfter?.segmentationVersion }, { next: progBefore?.nextParagraphIndex, last: progBefore?.lastCompletedParagraphIndex, ver: progBefore?.segmentationVersion }, 'Oracle B：不得推进/重置 Progress');
    assert.strictEqual(clearCalls, 0, 'Oracle B：不得删 Session/清 Anchor');
    hooks.__resetPlaybackSessionTestHooks();
    const okRetry = await getSession().getState().hydrateFromAnchor(anchorB as never, {
      getWork: async () => ({ title: 'oracleA', storyText: TWO, voiceId: 'alloy', contentHash: hashA }),
      getManifest: async () => ({ segments: [{ index: 0, text: FROZEN_A }, { index: 1, text: FROZEN_B }], segmentationVersion: 'legacy-v0', segmentCount: 2 }),
      clearAnchor: async () => { clearCalls += 1; return { cleared: true }; },
    });
    assert.strictEqual(okRetry, true, 'Oracle B：retry 后可恢复');
    assert.strictEqual(getSession().getState().status, 'ready', 'Oracle B：retry 后 ready');
    assert.deepStrictEqual(getSession().getState().paragraphs, [FROZEN_A, FROZEN_B], 'Oracle B：retry 后 frozen');
    console.log('=== B9. Oracle FIXUP-2 Blocking1 flag-off 仍 Manifest 权威（legacy-v0 + CANONICAL_AUDIO_ENABLED=0） ===');
    {
      const savedCanonB9 = process.env.CANONICAL_AUDIO_ENABLED;
      const savedPublicB9 = process.env.NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED;
      process.env.CANONICAL_AUDIO_ENABLED = '0';
      delete process.env.NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED;
      try {
        const workB9 = await prisma.storyWork.create({ data: { userId: user.id, prompt: 'oracleB9', storyText: TWO, voiceId: 'alloy', title: 'oracleB9', excerpt: 'e', contentHash: '', sourceMessageId: 'oracleB9-m1' } });
        await prisma.storyWork.update({ where: { id: workB9.id }, data: { contentHash: hashA } });
        const rB9 = await ensureStoryAudioSegmentForSubject(subject, { workId: workB9.id, segmentIndex: 0, sessionId: SID_E }, { synthesize: synth });
        assert.strictEqual(rB9.status, 'ready', 'B9 manifest 先建');
        const manB9 = await prisma.storyAudioManifest.findUnique({ where: { storyWorkId_version: { storyWorkId: workB9.id, version: 1 } } });
        assert.ok(manB9, 'B9 manifest 行存在');
        assert.strictEqual(manB9!.segmentCount, 2, 'B9 manifest segmentCount=2');
        await prisma.storyAudioManifest.update({ where: { id: manB9!.id }, data: { segmentationVersion: 'legacy-v0' } });
        await prisma.storyPlaybackProgress.upsert({
          where: { storyWorkId: workB9.id },
          create: { storyWorkId: workB9.id, contentHash: hashA, segmentationVersion: 'legacy-v0', lastCompletedParagraphIndex: 0, nextParagraphIndex: 1, totalParagraphs: 2, completedAt: null, lastPlayedAt: new Date() },
          update: { contentHash: hashA, segmentationVersion: 'legacy-v0', lastCompletedParagraphIndex: 0, nextParagraphIndex: 1, totalParagraphs: 2 },
        });
        const anchorB9 = await beginPlaybackSessionForSubject(subject, { sessionId: SID_F, source: { kind: 'work', workId: workB9.id }, mode: 'resume', speed: 1.0 });
        assert.strictEqual(anchorB9.segmentationVersion, 'legacy-v0', 'B9：Anchor version=legacy-v0（flag-off 仍 Manifest 权威）');
        assert.strictEqual(anchorB9.totalParagraphs, 2, 'B9：Anchor total=Manifest.segmentCount');
        assert.strictEqual(anchorB9.nextParagraphIndex, 1, 'B9：begin next 保留 1（不 reset）');
        resetWorld(); fakeController(pc1);
        process.env.CANONICAL_AUDIO_ENABLED = '0';
        delete process.env.NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED;
        const okB9 = await getSession().getState().hydrateFromAnchor(anchorB9 as never, {
          getWork: async () => ({ title: 'oracleB9', storyText: TWO, voiceId: 'alloy', contentHash: hashA }),
          getManifest: async () => ({ segments: [{ index: 0, text: FROZEN_A }, { index: 1, text: FROZEN_B }], segmentationVersion: 'legacy-v0', segmentCount: 2 }),
        });
        assert.strictEqual(okB9, true, 'B9：hydrate 成功');
        assert.strictEqual(getSession().getState().status, 'ready', 'B9：hydrate 进入 ready');
        assert.deepStrictEqual(getSession().getState().paragraphs, [FROZEN_A, FROZEN_B], 'B9：client paragraphs=frozen Manifest text（flag-off 不消失）');
        assert.strictEqual(getSession().getState().segmentationVersion, 'legacy-v0', 'B9：hydrate version 仍 legacy');
        assert.strictEqual(getSession().getState().nextParagraphIndex, 1, 'B9：hydrate next 保留 1');
        getTransport().setState({ isPlaying: true } as never);
        const ensureBeforeB9 = ensureCalls;
        const fetchBeforeB9 = fetchCalls;
        await getSession().getState().playParagraph(1, { explicit: true });
        assert.strictEqual(ensureCalls, ensureBeforeB9, 'B9：playParagraph 不调用 ensureSegment（flag-off 走 fetchAudio）');
        assert.ok(fetchCalls > fetchBeforeB9, 'B9：playParagraph 走 fetchAudio（ephemeral）');
        assert.ok((getTransport().getState().currentAudioUrl ?? '').startsWith('blob:'), 'B9：ephemeral blob URL');
      } finally {
        if (savedCanonB9 === undefined) delete process.env.CANONICAL_AUDIO_ENABLED;
        else process.env.CANONICAL_AUDIO_ENABLED = savedCanonB9;
        if (savedPublicB9 === undefined) delete process.env.NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED;
        else process.env.NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED = savedPublicB9;
      }
      process.env.CANONICAL_AUDIO_ENABLED = '1';
    }
    console.log('=== B10. Oracle FIXUP-2 Blocking2(a) legacy 完播 Progress 仍 Manifest pair，下次 resume 不 reset ===');
    {
      const workB10 = await prisma.storyWork.create({ data: { userId: user.id, prompt: 'oracleB10', storyText: TWO, voiceId: 'alloy', title: 'oracleB10', excerpt: 'e', contentHash: '', sourceMessageId: 'oracleB10-m1' } });
      await prisma.storyWork.update({ where: { id: workB10.id }, data: { contentHash: hashA } });
      const rB10 = await ensureStoryAudioSegmentForSubject(subject, { workId: workB10.id, segmentIndex: 0, sessionId: SID_G }, { synthesize: synth });
      assert.strictEqual(rB10.status, 'ready', 'B10 manifest 先建');
      const manB10 = await prisma.storyAudioManifest.findUnique({ where: { storyWorkId_version: { storyWorkId: workB10.id, version: 1 } } });
      assert.ok(manB10, 'B10 manifest 行存在');
      await prisma.storyAudioManifest.update({ where: { id: manB10!.id }, data: { segmentationVersion: 'legacy-v0' } });
      await prisma.storyPlaybackProgress.upsert({
        where: { storyWorkId: workB10.id },
        create: { storyWorkId: workB10.id, contentHash: hashA, segmentationVersion: 'legacy-v0', lastCompletedParagraphIndex: 0, nextParagraphIndex: 1, totalParagraphs: 2, completedAt: null, lastPlayedAt: new Date() },
        update: { contentHash: hashA, segmentationVersion: 'legacy-v0', lastCompletedParagraphIndex: 0, nextParagraphIndex: 1, totalParagraphs: 2 },
      });
      const anchorB10 = await beginPlaybackSessionForSubject(subject, { sessionId: SID_H, source: { kind: 'work', workId: workB10.id }, mode: 'resume', speed: 1.0 });
      assert.strictEqual(anchorB10.nextParagraphIndex, 1, 'B10 前提：begin 不 reset');
      const completedB10 = await completePlaybackSessionForSubject(subject, { sessionId: SID_H });
      assert.ok(completedB10, 'B10：complete 返回 Anchor');
      assert.strictEqual(completedB10!.segmentationVersion, 'legacy-v0', 'B10：完播 Anchor version 仍 legacy（不用当前重算）');
      assert.strictEqual(completedB10!.totalParagraphs, 2, 'B10：完播 Anchor total=Manifest.segmentCount');
      assert.strictEqual(completedB10!.nextParagraphIndex, 2, 'B10：完播 Anchor next=total');
      const progB10 = await prisma.storyPlaybackProgress.findUnique({ where: { storyWorkId: workB10.id } });
      assert.strictEqual(progB10?.segmentationVersion, 'legacy-v0', 'B10：Progress version 与 Manifest 相同（完播不写回当前版本）');
      assert.strictEqual(progB10?.totalParagraphs, 2, 'B10：Progress total 与 Manifest 相同');
      assert.strictEqual(progB10?.nextParagraphIndex, 2, 'B10：Progress next=total');
      assert.strictEqual(progB10?.lastCompletedParagraphIndex, 1, 'B10：Progress last=total-1');
      // §4 session ownership：同 source resume 须保持同一 session（换 UUID 即 BAD_REQUEST），
      // 故下一次 resume 沿用同一 SID_H（完播不制造 drift：hash/version 一致→保留 next=total）。
      const anchorB10Resume = await beginPlaybackSessionForSubject(subject, { sessionId: SID_H, source: { kind: 'work', workId: workB10.id }, mode: 'resume', speed: 1.0 });
      assert.strictEqual(anchorB10Resume.nextParagraphIndex, 2, 'B10：下一次 resume 不 reset（正常完播不制造 drift）');
      assert.strictEqual(anchorB10Resume.segmentationVersion, 'legacy-v0', 'B10：resume version 仍 legacy');
    }
    console.log('=== B11. Oracle FIXUP-2 Blocking2(b) promotion 目标已有 legacy Manifest → Anchor/Progress 用 Manifest pair ===');
    {
      const draftMsgB11 = `oracleB11-draft-${Date.now()}`;
      await prisma.chatMessage.create({ data: { userId: user.id, position: 0, messageId: draftMsgB11, role: 'assistant', content: 'draft', parts: null } });
      const workB11 = await prisma.storyWork.create({ data: { userId: user.id, prompt: 'oracleB11', storyText: TWO, voiceId: 'alloy', title: 'oracleB11', excerpt: 'e', contentHash: '', sourceMessageId: draftMsgB11 } });
      await prisma.storyWork.update({ where: { id: workB11.id }, data: { contentHash: hashA } });
      const rB11 = await ensureStoryAudioSegmentForSubject(subject, { workId: workB11.id, segmentIndex: 0, sessionId: SID_J }, { synthesize: synth });
      assert.strictEqual(rB11.status, 'ready', 'B11 manifest 先建');
      const manB11 = await prisma.storyAudioManifest.findUnique({ where: { storyWorkId_version: { storyWorkId: workB11.id, version: 1 } } });
      assert.ok(manB11, 'B11 manifest 行存在');
      await prisma.storyAudioManifest.update({ where: { id: manB11!.id }, data: { segmentationVersion: 'legacy-v0' } });
      const draftAnchorB11 = await beginPlaybackSessionForSubject(subject, { sessionId: SID_K, source: { kind: 'draft', messageId: draftMsgB11 }, mode: 'resume', speed: 1.0, draftSnapshot: { title: 'oracleB11-draft', contentHash: hashA, totalParagraphs: 2, voiceId: 'alloy' } });
      assert.strictEqual(draftAnchorB11.nextParagraphIndex, 0, 'B11 前提：draft begin position 0');
      const saveB11 = await savePlaybackCheckpointForSubject(subject, { sessionId: SID_K, contentHash: hashA, segmentationVersion: SEGMENTATION_VERSION, lastCompletedParagraphIndex: 0, nextParagraphIndex: 1, totalParagraphs: 2, speed: 1.0 });
      assert.strictEqual(saveB11.accepted, true, 'B11 前提：draft checkpoint 推进到 1');
      const promotedB11 = await promoteDraftPlaybackToWorkForSubject(subject, { sessionId: SID_K, workId: workB11.id });
      assert.strictEqual(promotedB11.sessionId, SID_K, 'B11：promotion 不变 sessionId');
      assert.deepStrictEqual(promotedB11.source, { kind: 'work', workId: workB11.id }, 'B11：source 切 work');
      assert.strictEqual(promotedB11.segmentationVersion, 'legacy-v0', 'B11：promoted Anchor 使用 Manifest version（非当前重算）');
      assert.strictEqual(promotedB11.totalParagraphs, 2, 'B11：promoted Anchor total=Manifest.segmentCount');
      assert.strictEqual(promotedB11.nextParagraphIndex, 1, 'B11：hash 一致沿用 draft 断点 1');
      const progB11 = await prisma.storyPlaybackProgress.findUnique({ where: { storyWorkId: workB11.id } });
      assert.ok(progB11, 'B11：promotion 建 Progress');
      assert.strictEqual(progB11!.segmentationVersion, 'legacy-v0', 'B11：promoted Progress 使用 Manifest version');
      assert.strictEqual(progB11!.totalParagraphs, 2, 'B11：promoted Progress total=Manifest.segmentCount');
      assert.strictEqual(progB11!.nextParagraphIndex, 1, 'B11：Progress next 与 Anchor 一致（Audio index == Progress index）');
      assert.strictEqual(progB11!.nextParagraphIndex, promotedB11.nextParagraphIndex, 'B11：Anchor/Progress index 一致');
      const segB11 = await ensureStoryAudioSegmentForSubject(subject, { workId: workB11.id, segmentIndex: progB11!.nextParagraphIndex, sessionId: SID_K }, { synthesize: synth });
      assert.strictEqual(segB11.status, 'ready', 'B11：后续 canonical segment index 与 Progress index 一致（可就绪）');
    }
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

