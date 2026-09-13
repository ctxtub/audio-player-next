import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  createToastCapture,
  installGlassToastStub,
} from '../../support/mocks/ui-state.mock';
import {
  normalizeStoryText,
  segmentStoryText,
} from '../../../utils/segmentation';
import {
  decideCheckpointAcceptance,
  isStaleSession,
} from '../../../lib/playback/session';
import {
  continuationModeToLegacyIsOneShot,
  rehydratedContinuationMode,
  resolveContinuationMode,
} from '../../../lib/playback/progress';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const toastCapture = createToastCapture();
installGlassToastStub(toastCapture);

// 中文注释：fetchAudio 可编程桩（§50 stale TTS 运行时证明用）。
// 必须在任何 store/flow 被求值之前劫持 require 缓存（与 GlassToast 桩同机制）。
type FetchBehavior = () => Promise<string>;
const fetchQueue: FetchBehavior[] = [];
let fetchCalls = 0;
const ttsPath = path.resolve(process.cwd(), 'lib/client/ttsGenerate.ts');
nodeRequire.cache[ttsPath] = {
  id: ttsPath,
  filename: ttsPath,
  loaded: true,
  exports: {
    fetchAudio: async (): Promise<string> => {
      fetchCalls += 1;
      const behavior = fetchQueue.shift();
      if (behavior) return behavior();
      return `blob:mock-${fetchCalls}`;
    },
  },
} as unknown as NodeModule;

function deferBlob() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Session / transport / flow 经 require 懒取（须在桩安装之后）。
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
const getFlow = () =>
  nodeRequire('../../../app/services/playbackSessionFlow') as typeof import('../../../app/services/playbackSessionFlow');
const getStoryFlow = () =>
  nodeRequire('../../../app/services/storyFlow') as typeof import('../../../app/services/storyFlow');

/**
 * M5-10 Playback Runtime Orchestration & M5 E2E Closure（L1，§26/§27/§28/§50/§52）。
 *
 * §49 E2E 清单 → 本仓库覆盖映射（行为不变的运行时收线，回归由下列既有套件承载）：
 * - 跨 /chat /library /setting 播放不断 → transport ownership 留 Host（本文件 §26 断言）
 * - 播放 Work → Pause → Refresh → Ready → Resume → exec-playback-session-rehydrate(+server)
 * - Work A → Work B stale A save 不覆盖 B → exec-playback-checkpoint-guards（server 门）＋本文件 §50 client 门
 * - Work 完播 → Library 显示完成 → exec-playback-session-lifecycle-promotion（§40）
 * - 已完成重播半途退出 Continue → exec-playback-session-rehydrate（越界钳制/断点保留）
 * - Draft 播放中完成 StoryWork 创建 → 无缝 promotion → exec-playback-session-lifecycle-promotion
 * - 删除当前作品 → exec-playback-lifecycle-trash（dangling fail-closed）
 * - Guest 注册后 Resume identity → exec-playback-subject-remap / exec-playback-remap-merge
 * - Audio unlock 不回归 → 本文件 §26（unlock/ended-guard 回归边界）＋ exec-audio-ended-guard
 * - pause 禁自动 preload/auto continue → exec-paragraph-transition-guard ＋ 本文件 §28 finite 门
 *
 * 本文件新增证明（M5-10 收线点）：
 * §26 Host 零故事依赖且保留 transport ownership；
 * §27 flow 九动词齐备且全部委托 Session SSOT；
 * §28 continuation 唯一门 continuationMode==='extendable'（flow 侧零旧 guard 读取）；
 * §50 client stale async TTS 丢弃（含 legacy 合成路径）；
 * §52 三权分立（Session SSOT / Transport / Per-Work durable）。
 * 纯内存＋桩 fetchAudio，不触库、不调网络。
 */

const SID_A = 'a47ac10b-58cc-4372-a567-0e02b2c3d47a';
const SID_B = 'b47ac10b-58cc-4372-a567-0e02b2c3d47b';
const SID_C = 'c47ac10b-58cc-4372-a567-0e02b2c3d47c';
const SID_D = 'd47ac10b-58cc-4372-a567-0e02b2c3d47d';

// 两段 120 字级中文段落（首段 ≥80 字不触发前向合并，单段 ≤350 字不触发二次拆分，恒为 2 段）。
const PARA_1 = `第一自然段：很久很久以前在宁静的大森林深处住着一只聪明活泼的小松鼠它有一条蓬松柔软的大尾巴每天清晨都在高高的树梢之间欢快地跳来跳去寻找新鲜的坚果与甘甜的露水日子过得无忧无虑。`;
const PARA_2 = `第二自然段：小松鼠每天迎着金色的朝阳出门收集松果仔细辨别每一颗果实是否饱满香甜然后整整齐齐存放在自己温暖干燥的树洞深处为即将到来的漫长寒冬储备充足的粮食心里充满了丰收的喜悦。`;
const TWO_PARAGRAPHS = `${PARA_1}\n${PARA_2}`;

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
    // 清理失败忽略，复位继续。
  }
  useTransport.getState().reset();
  useTransport.setState({
    _tickIntervalId: null,
    _lastTickAt: null,
    isPlaying: false,
  });
}

function installFakeController(playCalls: string[]) {
  getTransportStore().getState().registerAudioController({
    unlock: async () => {},
    play: async (audioUrl: string) => {
      playCalls.push(audioUrl);
    },
    resume: async () => {},
    pause: () => {},
    seek: () => {},
    setPlaybackRate: () => {},
  });
}

async function runPlaybackRuntimeOrchestrationTests(): Promise<void> {
  console.log('=== M5-10: Playback Runtime Orchestration & M5 Closure (unit) ===');

  // —— 前置：分段假设锁死（2 段），config 预算/音色显式化 ——
  const paragraphs = segmentStoryText(normalizeStoryText(TWO_PARAGRAPHS));
  assert.ok(
    paragraphs.length >= 2,
    `前置假设：双段文本必须切出 ≥2 段，实际 ${paragraphs.length}`,
  );
  const useConfig = getConfigStore();
  useConfig.setState({
    apiConfig: { ...useConfig.getState().apiConfig, playDuration: 30, voiceId: 'alloy', speed: 1 },
  });

  // —— §26 Host：零故事依赖＋transport ownership 回归边界 ——
  console.log('--- §26 AudioControllerHost reports events only ---');
  const hostSource = fs.readFileSync(
    path.resolve(process.cwd(), 'components/AudioControllerHost/index.tsx'),
    'utf8',
  );
  const hostCode = stripComments(hostSource);
  for (const banned of [
    /from\s+['"]@\/stores\/chatStore['"]/,
    /from\s+['"]@\/stores\/preloadStore['"]/,
    /from\s+['"]@\/stores\/playbackProgressStore['"]/,
    /from\s+['"]@\/app\/services\/storyFlow['"]/,
    /useChatStore\(/,
    /usePreloadStore\(/,
    /usePlaybackProgressStore\(/,
  ]) {
    assert.ok(!banned.test(hostCode), `Host 不得触故事领域：${String(banned)}（§26.1）`);
  }
  assert.ok(hostCode.includes('playbackSessionFlow'), 'Host 必须经 PlaybackSessionFlow 报告事件');
  for (const owned of [
    'registerAudioController',
    'handleUnlock',
    'handlePlay',
    'handleResume',
    'handlePause',
    'handleSeek',
    'handleSetPlaybackRate',
    'timeupdate',
    'loadedmetadata',
    'ended',
  ]) {
    assert.ok(hostCode.includes(owned), `Host 必须保留 transport ownership：${owned}`);
  }
  // unlock/pause/seek/near-end 回归边界（移动端行为不得重写）。
  for (const boundary of [
    'SILENT_AUDIO_DATA_URL',
    'isPlayInterruptedError',
    'createAudioEndedGuard',
    'hasTriggeredPreload',
    'isUnlockingRef',
  ]) {
    assert.ok(hostCode.includes(boundary), `Host 回归边界必须保留：${boundary}`);
  }
  console.log('PASS: Host reports-only verified');

  // —— §27 flow 九动词＋委托 ——
  console.log('--- §27 PlaybackSessionFlow surface & delegation ---');
  const flowSource = fs.readFileSync(
    path.resolve(process.cwd(), 'app/services/playbackSessionFlow.ts'),
    'utf8',
  );
  const flowCode = stripComments(flowSource);
  for (const fn of [
    'beginPlayback',
    'resumePlayback',
    'playParagraph',
    'handleNearEnd',
    'handleEnded',
    'pausePlayback',
    'restartPlayback',
    'promoteDraftToWork',
    'stopPlayback',
    'shouldAllowAiContinuation',
  ]) {
    assert.ok(flowCode.includes(`function ${fn}`), `flow 必须导出 ${fn}（§27）`);
  }
  for (const alias of ['as pause', 'as restart', 'as stop']) {
    assert.ok(flowCode.includes(alias), `flow 必须提供 §27 规范名别名：${alias}`);
  }
  for (const delegation of [
    '.beginPlayback(',
    '.resumeRehydratedPlayback(',
    '.playParagraph(',
    '.handleExplicitPause(',
    '.restart(',
    '.promoteDraftToWork(',
    '.stop(',
    '.handleParagraphEnded(',
    '.prefetchNextParagraph(',
  ]) {
    assert.ok(flowCode.includes(delegation), `flow 必须委托 Session SSOT：${delegation}`);
  }
  // §28：flow 侧一律不读取旧 guard（注释剥离后零残留）。
  for (const retired of ['isOneShot', 'sourceId', 'currentMessageId']) {
    assert.ok(
      !flowCode.includes(retired),
      `flow 不得读取旧规则 ${retired}（§28 退役）`,
    );
  }
  assert.ok(
    flowCode.includes("continuationMode === 'extendable'") ||
      flowCode.includes('shouldAllowAiContinuation(session.continuationMode)'),
    'flow 必须以 continuationMode 唯一门判定续写（§28）',
  );
  const flow = getFlow();
  for (const name of [
    'beginPlayback',
    'resumePlayback',
    'playParagraph',
    'handleNearEnd',
    'handleEnded',
    'pause',
    'restart',
    'promoteDraftToWork',
    'stop',
    'pausePlayback',
    'restartPlayback',
    'stopPlayback',
    'shouldAllowAiContinuation',
    'reportPlaybackStart',
    'reportPlaybackPause',
    'reportProgress',
    'reportTimeUpdate',
  ] as const) {
    assert.strictEqual(typeof flow[name], 'function', `flow.${name} 必须为函数`);
  }
  assert.strictEqual(flow.shouldAllowAiContinuation('finite'), false);
  assert.strictEqual(flow.shouldAllowAiContinuation('extendable'), true);
  console.log('PASS: flow surface verified');

  // —— §28 continuation 语义（纯领域映射） ——
  console.log('--- §28 continuation mapping ---');
  assert.strictEqual(
    resolveContinuationMode({ kind: 'work', rehydrated: false }),
    'finite',
    'work → finite（恒）',
  );
  assert.strictEqual(
    resolveContinuationMode({ kind: 'draft', rehydrated: true }),
    'finite',
    'rehydrated draft → finite（恒）',
  );
  assert.strictEqual(
    resolveContinuationMode({ kind: 'draft', rehydrated: false, liveExtendable: true }),
    'extendable',
    'live draft 显式 extendable → extendable',
  );
  assert.strictEqual(
    resolveContinuationMode({ kind: 'draft', rehydrated: false }),
    'finite',
    'live draft 默认 → finite（安全边界）',
  );
  assert.strictEqual(rehydratedContinuationMode(), 'finite');
  assert.strictEqual(continuationModeToLegacyIsOneShot('finite'), true);
  assert.strictEqual(continuationModeToLegacyIsOneShot('extendable'), false);
  // storyFlow 旧判定退役：session ownership 早退必须同时守住 near-end 与 ended。
  const storySource = fs.readFileSync(
    path.resolve(process.cwd(), 'app/services/storyFlow.ts'),
    'utf8',
  );
  const storyCode = stripComments(storySource);
  const yieldUses = storyCode.match(/shouldYieldToPlaybackSession\(\)/g) ?? [];
  assert.ok(
    storyCode.includes('const shouldYieldToPlaybackSession'),
    'storyFlow 必须定义 session ownership 早退',
  );
  assert.ok(
    yieldUses.length >= 2,
    `storyFlow 早退须同时守住 handleNearEnd 与 handleSegmentEnded，实际 ${yieldUses.length}`,
  );
  assert.ok(
    storyCode.includes("continuationMode !== 'extendable'"),
    'storyFlow 早退须以 continuationMode 为准（§28）',
  );
  assert.ok(storyCode.includes('originatingSessionId'), 'storyFlow 须有 §50 synth 守卫');
  console.log('PASS: continuation mapping verified');

  // —— §28 运行时：finite 会话下 legacy near-end/ended 直接让路 ——
  console.log('--- §28 runtime: legacy yields to finite session ---');
  resetPlaybackWorld();
  const useSession = getSessionStore();
  const useTransport = getTransportStore();
  useSession.getState().setActiveStory({
    source: { kind: 'work', workId: 7 },
    sessionId: SID_A,
    title: '让路对照',
    storyText: TWO_PARAGRAPHS,
    voiceId: 'alloy',
    speed: 1,
  });
  assert.strictEqual(useSession.getState().continuationMode, 'finite');
  const storyFlow = getStoryFlow();
  const endedYield = await storyFlow.handleSegmentEnded();
  assert.strictEqual(endedYield, null, 'finite 会话下 legacy ended 必须 bare null 让路');
  assert.deepStrictEqual(
    useSession.getState().source,
    { kind: 'work', workId: 7 },
    '让路不得触会话 source',
  );
  assert.strictEqual(
    useTransport.getState().currentAudioUrl,
    null,
    '让路不得触 transport 音轨',
  );
  await storyFlow.handleNearEnd();
  assert.deepStrictEqual(
    useSession.getState().source,
    { kind: 'work', workId: 7 },
    'near-end 让路不得触会话',
  );
  console.log('PASS: legacy yields verified');

  // —— §50 运行时：session 切走后旧 TTS 晚到丢弃（client 门） ——
  console.log('--- §50 runtime: stale synth result discarded ---');
  resetPlaybackWorld();
  const playCalls: string[] = [];
  installFakeController(playCalls);
  useSession.getState().setActiveStory({
    source: { kind: 'work', workId: 7 },
    sessionId: SID_A,
    title: '会话A',
    storyText: TWO_PARAGRAPHS,
    voiceId: 'alloy',
    speed: 1,
  });
  const lateA = deferBlob();
  fetchQueue.push(() => lateA.promise);
  const pendingA = useSession.getState().playParagraph(0);
  // 切源：B 会话建立（A 的 TTS 仍在途）。
  useSession.getState().setActiveStory({
    source: { kind: 'work', workId: 8 },
    sessionId: SID_B,
    title: '会话B',
    storyText: TWO_PARAGRAPHS,
    voiceId: 'alloy',
    speed: 1,
  });
  lateA.resolve('blob:stale-a');
  await pendingA;
  assert.ok(
    !playCalls.includes('blob:stale-a'),
    'A 的晚到 TTS 不得覆盖 B（revoke/discard，§50）',
  );
  assert.deepStrictEqual(useSession.getState().source, { kind: 'work', workId: 8 });
  // B 正常播放不受影响。
  await useSession.getState().playParagraph(0, { explicit: true });
  assert.strictEqual(playCalls.length, 1, 'B 应恰好播一次');
  assert.ok(playCalls[0].startsWith('blob:mock-'), 'B 播放其自身合成结果');
  assert.strictEqual(useTransport.getState().currentAudioUrl, playCalls[0]);
  console.log('PASS: stale synth discard verified');

  // —— §50 运行时：legacy 合成路径同门（session 切换 → discard；无切换 → 照播） ——
  console.log('--- §50 runtime: legacy synth path guarded ---');
  resetPlaybackWorld();
  const legacyCalls: string[] = [];
  installFakeController(legacyCalls);
  useSession.getState().setActiveStory({
    source: { kind: 'work', workId: 9 },
    sessionId: SID_C,
    title: '会话C',
    storyText: TWO_PARAGRAPHS,
    voiceId: 'alloy',
    speed: 1,
  });
  const lateLegacy = deferBlob();
  fetchQueue.push(() => lateLegacy.promise);
  const pendingLegacy = getStoryFlow().playStoryText('瞬态合成正文：无稳定标识的降级播放路径。');
  useSession.getState().setActiveStory({
    source: { kind: 'work', workId: 10 },
    sessionId: SID_D,
    title: '会话D',
    storyText: TWO_PARAGRAPHS,
    voiceId: 'alloy',
    speed: 1,
  });
  lateLegacy.resolve('blob:stale-legacy');
  await pendingLegacy;
  assert.ok(
    !legacyCalls.includes('blob:stale-legacy'),
    'legacy 晚到合成不得覆盖新会话（§50）',
  );
  assert.deepStrictEqual(useSession.getState().source, { kind: 'work', workId: 10 });
  // 无切换对照：legacy 照常播（守卫不误伤）。
  await getStoryFlow().playStoryText('对照合成正文：同一会话内发起并返回。');
  assert.strictEqual(legacyCalls.length, 1, '无切换时 legacy 合成应照播');
  console.log('PASS: legacy synth guard verified');

  // —— §50 纯判定：stale checkpoint 拒绝（server 门的 client 侧对称） ——
  console.log('--- §50 decision: stale session rejected ---');
  assert.deepStrictEqual(decideCheckpointAcceptance(SID_A, SID_B), {
    accepted: false,
    reason: 'STALE_SESSION',
  });
  assert.strictEqual(isStaleSession(SID_A, SID_B), true);
  assert.deepStrictEqual(decideCheckpointAcceptance(SID_A, SID_A), { accepted: true });
  assert.strictEqual(isStaleSession(SID_A, SID_A), false);
  console.log('PASS: stale decision verified');

  // —— §52 三权分立：SSOT / Transport / durable 各归其位 ——
  console.log('--- §52 responsibility split ---');
  const sessionKeys = Object.keys(useSession.getState());
  for (const key of ['sessionId', 'source', 'continuationMode', 'status', 'nextParagraphIndex']) {
    assert.ok(sessionKeys.includes(key), `Session SSOT 必须持有 ${key}（现在听什么）`);
  }
  const transportKeys = Object.keys(useTransport.getState());
  for (const key of ['audioController', 'isPlaying', 'currentAudioUrl', 'currentTime', 'duration']) {
    assert.ok(transportKeys.includes(key), `Transport 必须持有 ${key}（播到哪）`);
  }
  const sessionSource = fs.readFileSync(
    path.resolve(process.cwd(), 'stores/playbackSessionStore.ts'),
    'utf8',
  );
  assert.ok(
    !stripComments(sessionSource).includes("from '@/app/services/storyFlow'"),
    'Session SSOT 不得依赖编排层（§52 单向依赖）',
  );
  console.log('PASS: responsibility split verified');

  resetPlaybackWorld();
  console.log('\nALL M5-10 RUNTIME ORCHESTRATION TESTS PASSED!');
}

const testPromise = runPlaybackRuntimeOrchestrationTests()
  .then(() => {
    console.log('ALL M5-10 RUNTIME ORCHESTRATION TESTS PASSED!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;
