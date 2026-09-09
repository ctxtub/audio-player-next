import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

// 中文注释：预置 GlassToast 打桩，避免 store 触发真实 UI 依赖。
const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
nodeRequire.cache[glassToastPath] = {
  id: glassToastPath,
  filename: glassToastPath,
  loaded: true,
  exports: {
    default: {
      show: () => {},
      clear: () => {},
    },
  },
} as unknown as NodeModule;

const { usePlaybackStore } = nodeRequire('../stores/playbackStore') as {
  usePlaybackStore: typeof import('../stores/playbackStore').usePlaybackStore;
};
const { usePlaybackProgressStore } = nodeRequire('../stores/playbackProgressStore') as {
  usePlaybackProgressStore: typeof import('../stores/playbackProgressStore').usePlaybackProgressStore;
};
const { useConfigStore } = nodeRequire('../stores/configStore') as {
  useConfigStore: typeof import('../stores/configStore').useConfigStore;
};

// 中文注释：四段式故事正文，每段足够长以保证切分为 4 段。
const PARA1 =
  '第一自然段：很久很久以前，在宁静的大森林深处住着一只聪明活泼的小松鼠，它有一条蓬松的大尾巴，每天清晨都在高高的树梢间欢快地跳来跳去，寻找新鲜的坚果与甘甜的露水。';
const PARA2 =
  '第二自然段：小松鼠每天早晨迎着金色的朝阳出门收集松果，仔细辨别每一颗果实是否饱满香甜，并将它们整齐地存放在自己温暖干燥的树洞深处，准备迎接即将到来的寒冷冬天。它还会在洞口铺上柔软的干草。';
const PARA3 =
  '第三自然段：有一天它在一棵巨大的古老松树下发现了一颗闪闪发光的神奇松果，散发出奇异而温暖的柔和光芒，不仅照亮了周围湿漉漉的青苔，还散发出一种让人心情平静的香气。';
const PARA4 =
  '第四自然段：这颗发光的松果带领着好奇的小松鼠走进了森林最深处的奇妙花园，那里盛开着从未见过的美丽奇幻花朵，彩色的蝴蝶在花丛中翩翩起舞，宛如梦境一般美丽动人。小松鼠决定把这份喜悦分享给森林里的每一位朋友。';
const STORY_TEXT = `${PARA1}\n${PARA2}\n${PARA3}\n${PARA4}`;
const SOURCE_ID = 'msg_h08_explicit';

// 中文注释：拦截 TTS 合成文本，仅统计 tts.synthesize（fetchAudio）调用。
const synthRequests: string[] = [];
const originalFetch = globalThis.fetch;
type TrpcBatchBody = Record<string, { json?: { text?: unknown } }>;
globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'POST' && typeof init?.body === 'string') {
    try {
      const parsed = JSON.parse(init.body) as TrpcBatchBody;
      for (const key of Object.keys(parsed)) {
        const text = parsed[key]?.json?.text;
        if (typeof text === 'string') {
          synthRequests.push(text);
        }
      }
    } catch {
      // 中文注释：非 tRPC 批量体则忽略。
    }
  }
  const item = {
    result: { data: { json: { audioBase64: 'AA==', contentType: 'audio/mpeg' } } },
  };
  return new Response(JSON.stringify(item), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

// 中文注释：node 缺少 URL.createObjectURL，打桩以走通 fetchAudio 的 Blob 收尾。
const urlStatics = URL as unknown as { createObjectURL?: (obj: object) => string };
const originalCreateObjectURL = urlStatics.createObjectURL;
urlStatics.createObjectURL = () => `blob:mock-audio-${synthRequests.length}-${Date.now()}`;

/** 中文注释：播放控制器打桩，统计 play/resume 调用以判定是否出声。 */
let playCalls = 0;
let resumeCalls = 0;
function installController(): void {
  playCalls = 0;
  resumeCalls = 0;
  usePlaybackStore.getState().registerAudioController({
    unlock: async () => {},
    play: async () => {
      playCalls += 1;
    },
    resume: async () => {
      resumeCalls += 1;
    },
    pause: () => {},
    seek: () => {},
    setPlaybackRate: () => {},
  });
}

/** 中文注释：重置双 store 到干净基线。 */
function resetStores(): void {
  try {
    const intervalId = (
      usePlaybackStore.getState() as unknown as { _tickIntervalId: number | null }
    )._tickIntervalId;
    if (intervalId !== null) {
      clearInterval(intervalId as unknown as Parameters<typeof clearInterval>[0]);
    }
  } catch {
    // 中文注释：清理失败忽略。
  }
  usePlaybackStore.getState().reset();
  usePlaybackProgressStore.getState().reset();
  usePlaybackStore.setState({ _tickIntervalId: null, _lastTickAt: null });
}

/** 中文注释：装载 4 段活跃故事，使 playParagraph 有可播段落。 */
function seedActiveStory(): void {
  usePlaybackProgressStore.getState().setActiveStory({
    sourceType: 'chat',
    sourceId: SOURCE_ID,
    sessionId: SOURCE_ID,
    title: '音频故事',
    storyText: STORY_TEXT,
    voiceId: 'alloy',
    speed: 1.0,
    isOneShot: false,
    remainingAllowedMs: 30 * 60000,
    totalAllowedMs: 30 * 60000,
    initialNextIndex: 1,
  });
}

/** 中文注释：暂停有轨态基线（X1 形状），仅替换倒计时预算。 */
function seedPausedWithTrack(remainingMs: number | null): void {
  usePlaybackStore.setState({
    isPlaying: false,
    remainingMs,
    totalAllowedMs: 30 * 60000,
    currentAudioUrl: 'blob:mock-current-track',
    currentMessageId: SOURCE_ID,
    _tickIntervalId: null,
    _lastTickAt: null,
  });
}

async function runH08ExplicitTests(): Promise<void> {
  console.log('=== H-08 残留：显式播放路径 0 预算守卫（E2E-W2C-03-02） ===');
  useConfigStore.setState((state) => ({
    apiConfig: { ...state.apiConfig, playDuration: 30, voiceId: 'alloy', speed: 1.0 },
  }));

  // 用例一：0 预算显式 playParagraph 不得出声，且进度行 next 不变、无合成浪费。
  console.log('--- H-08-E1: 0 预算显式 playParagraph 必须拦截 ---');
  resetStores();
  installController();
  seedActiveStory();
  seedPausedWithTrack(0);
  synthRequests.length = 0;
  playCalls = 0;
  const nextBefore = usePlaybackProgressStore.getState().nextParagraphIndex;
  const urlBefore = usePlaybackStore.getState().currentAudioUrl;
  // 中文注释：播与当前 next 不同的段，使“推进 next”在缺守卫时可被观测（RED 可见）。
  await usePlaybackProgressStore.getState().playParagraph(2, { explicit: true });
  assert.strictEqual(playCalls, 0, '0 预算显式 playParagraph 不得调用 controller.play（不得出声）');
  assert.strictEqual(synthRequests.length, 0, '0 预算显式 playParagraph 不得触发 TTS 合成');
  assert.strictEqual(
    usePlaybackProgressStore.getState().nextParagraphIndex,
    nextBefore,
    '0 预算显式 playParagraph 不得推进进度行 next',
  );
  assert.strictEqual(
    usePlaybackStore.getState().currentAudioUrl,
    urlBefore,
    '0 预算显式 playParagraph 不得切换在播轨道',
  );
  console.log('PASS: H-08-E1 zero-budget-explicit-playParagraph-blocked verified');

  // 用例二：0 预算显式 playAudio 不得出声、不切轨。
  console.log('--- H-08-E2: 0 预算显式 playAudio 必须拦截 ---');
  resetStores();
  installController();
  seedPausedWithTrack(0);
  playCalls = 0;
  await usePlaybackStore.getState().playAudio('blob:mock-next-track', SOURCE_ID, { explicit: true });
  assert.strictEqual(playCalls, 0, '0 预算显式 playAudio 不得调用 controller.play（不得出声）');
  assert.strictEqual(
    usePlaybackStore.getState().currentAudioUrl,
    'blob:mock-current-track',
    '0 预算显式 playAudio 不得切换在播轨道',
  );
  console.log('PASS: H-08-E2 zero-budget-explicit-playAudio-blocked verified');

  // 用例三：0 预算 resumeAudio 不得续响音频元素（E2E 点击 2 路径）。
  console.log('--- H-08-E3: 0 预算 resumeAudio 必须拦截 ---');
  resetStores();
  installController();
  seedPausedWithTrack(0);
  resumeCalls = 0;
  await usePlaybackStore.getState().resumeAudio();
  assert.strictEqual(resumeCalls, 0, '0 预算 resumeAudio 不得调用 controller.resume（不得续响）');
  console.log('PASS: H-08-E3 zero-budget-resumeAudio-blocked verified');

  // 用例四：0 预算显式恢复链 resumeRehydratedPlayback 不得出声、不推进 next。
  console.log('--- H-08-E4: 0 预算 resumeRehydratedPlayback 必须拦截 ---');
  resetStores();
  installController();
  seedActiveStory();
  seedPausedWithTrack(0);
  synthRequests.length = 0;
  playCalls = 0;
  const resumeNextBefore = usePlaybackProgressStore.getState().nextParagraphIndex;
  await usePlaybackProgressStore.getState().resumeRehydratedPlayback();
  assert.strictEqual(playCalls, 0, '0 预算恢复链不得调用 controller.play（不得出声）');
  assert.strictEqual(synthRequests.length, 0, '0 预算恢复链不得触发 TTS 合成');
  assert.strictEqual(
    usePlaybackProgressStore.getState().nextParagraphIndex,
    resumeNextBefore,
    '0 预算恢复链不得推进进度行 next',
  );
  console.log('PASS: H-08-E4 zero-budget-resume-chain-blocked verified');

  // 用例五：正常预算暂停态显式 playParagraph 必须放行（X1 H-07-05 语义兼容）。
  console.log('--- H-08-E5: 正常预算显式 playParagraph 必须放行 ---');
  resetStores();
  installController();
  seedActiveStory();
  seedPausedWithTrack(30 * 60000);
  synthRequests.length = 0;
  playCalls = 0;
  await usePlaybackProgressStore.getState().playParagraph(2, { explicit: true });
  assert.strictEqual(playCalls, 1, '正常预算显式 playParagraph 必须调用 controller.play 出声');
  assert.strictEqual(
    usePlaybackProgressStore.getState().nextParagraphIndex,
    2,
    '正常预算显式 playParagraph 必须推进进度行 next',
  );
  console.log('PASS: H-08-E5 normal-budget-explicit-playParagraph-continues verified');

  // 用例六：正常预算暂停态显式 playAudio 必须放行（X1 H-07-04-explicit 语义兼容）。
  console.log('--- H-08-E6: 正常预算显式 playAudio 必须放行 ---');
  resetStores();
  installController();
  seedPausedWithTrack(30 * 60000);
  playCalls = 0;
  await usePlaybackStore.getState().playAudio('blob:mock-next-track', SOURCE_ID, { explicit: true });
  assert.strictEqual(playCalls, 1, '正常预算显式 playAudio 必须调用 controller.play 出声');
  assert.strictEqual(
    usePlaybackStore.getState().currentAudioUrl,
    'blob:mock-next-track',
    '正常预算显式 playAudio 必须切换到新轨道',
  );
  console.log('PASS: H-08-E6 normal-budget-explicit-playAudio-continues verified');

  // 用例七：未知预算（null）显式 playParagraph 保持既有放行语义（fix01/fix03 新故事路径兼容）。
  console.log('--- H-08-E7: null 预算显式 playParagraph 保持放行 ---');
  resetStores();
  installController();
  seedActiveStory();
  seedPausedWithTrack(null);
  synthRequests.length = 0;
  playCalls = 0;
  await usePlaybackProgressStore.getState().playParagraph(1, { explicit: true });
  assert.strictEqual(playCalls, 1, 'null 预算显式 playParagraph 必须放行（未知预算≠耗尽）');
  console.log('PASS: H-08-E7 null-budget-explicit-preserved verified');

  console.log('\nALL H-08 EXPLICIT-BUDGET TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runH08ExplicitTests()
  .then(() => {
    console.log('ALL H-08 EXPLICIT-BUDGET TEST CASES PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  })
  .finally(() => {
    // 中文注释：恢复全局打桩，避免污染后续套件。
    globalThis.fetch = originalFetch;
    if (originalCreateObjectURL) {
      urlStatics.createObjectURL = originalCreateObjectURL;
    } else {
      delete urlStatics.createObjectURL;
    }
  });

export default testPromise;
