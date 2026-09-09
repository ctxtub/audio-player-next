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

const { usePlaybackStore } = nodeRequire('../../../stores/playbackStore') as {
  usePlaybackStore: typeof import('../../../stores/playbackStore').usePlaybackStore;
};
const { usePlaybackProgressStore } = nodeRequire('../../../stores/playbackProgressStore') as {
  usePlaybackProgressStore: typeof import('../../../stores/playbackProgressStore').usePlaybackProgressStore;
};
const { useConfigStore } = nodeRequire('../../../stores/configStore') as {
  useConfigStore: typeof import('../../../stores/configStore').useConfigStore;
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
const SOURCE_ID = 'msg_h07_guard';

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

// 中文注释：node 22 自带 navigator 但 onLine 可能为 undefined，保存原始引用以便恢复。
const originalNavigator = globalThis.navigator;

/** 中文注释：播放控制器打桩，统计 play 调用以判定是否续播。 */
let playCalls = 0;
function installController(): void {
  playCalls = 0;
  usePlaybackStore.getState().registerAudioController({
    unlock: async () => {},
    play: async () => {
      playCalls += 1;
    },
    resume: async () => {},
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
    initialNextIndex: 0,
  });
}

async function runH07Tests(): Promise<void> {
  console.log('=== H-07: 切换窗口内暂停不续播（isPlaying 守卫） ===');
  useConfigStore.setState((state) => ({
    apiConfig: { ...state.apiConfig, playDuration: 30, voiceId: 'alloy', speed: 1.0 },
  }));
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { ...originalNavigator, onLine: true },
      configurable: true,
      writable: true,
    });
  } catch {
    // 中文注释：重定义失败则忽略，浏览器侧在线态天然成立。
  }
  installController();

  // 用例一：正常切换语义——播放态 playParagraph 必须续播。
  console.log('--- H-07-01: 播放态切换必须续播（正常语义不受影响） ---');
  resetStores();
  installController();
  seedActiveStory();
  usePlaybackStore.setState({
    isPlaying: true,
    remainingMs: 30 * 60000,
    totalAllowedMs: 30 * 60000,
    currentAudioUrl: 'blob:mock-current-track',
    currentMessageId: SOURCE_ID,
  });
  synthRequests.length = 0;
  playCalls = 0;
  await usePlaybackProgressStore.getState().playParagraph(1);
  assert.strictEqual(playCalls, 1, '播放态切换必须调用 controller.play 续播下一段');
  console.log('PASS: H-07-01 playing-continues verified');

  // 用例二：窗口内暂停后无续播——暂停态 playParagraph 不得覆盖暂停意图。
  console.log('--- H-07-02: 窗口内暂停后不得续播 ---');
  resetStores();
  installController();
  seedActiveStory();
  usePlaybackStore.setState({
    isPlaying: false,
    remainingMs: 30 * 60000,
    totalAllowedMs: 30 * 60000,
    currentAudioUrl: 'blob:mock-current-track',
    currentMessageId: SOURCE_ID,
  });
  synthRequests.length = 0;
  playCalls = 0;
  const urlBefore = usePlaybackStore.getState().currentAudioUrl;
  await usePlaybackProgressStore.getState().playParagraph(1);
  assert.strictEqual(playCalls, 0, '暂停窗口内 playParagraph 不得调用 controller.play（不得覆盖暂停意图）');
  assert.strictEqual(
    usePlaybackStore.getState().currentAudioUrl,
    urlBefore,
    '暂停窗口内不得切换在播轨道',
  );
  console.log('PASS: H-07-02 paused-window-no-continue verified');

  // 用例三：初始起播语义——无轨道暂停态 playParagraph(0) 必须放行。
  console.log('--- H-07-03: 初始起播不受守卫误伤 ---');
  resetStores();
  installController();
  seedActiveStory();
  usePlaybackStore.setState({
    isPlaying: false,
    remainingMs: 30 * 60000,
    totalAllowedMs: 30 * 60000,
    currentAudioUrl: null,
    currentMessageId: null,
  });
  synthRequests.length = 0;
  playCalls = 0;
  await usePlaybackProgressStore.getState().playParagraph(0);
  assert.strictEqual(playCalls, 1, '初始起播（无轨道）必须放行，不得被窗口守卫误伤');
  console.log('PASS: H-07-03 initial-start-preserved verified');

  // 用例四：playAudio 直调守卫——暂停且有轨道时自动链不得续播，显式点播必须放行。
  console.log('--- H-07-04: playAudio 暂停窗口守卫（auto 拦截 / explicit 放行） ---');
  resetStores();
  installController();
  usePlaybackStore.setState({
    isPlaying: false,
    remainingMs: 30 * 60000,
    totalAllowedMs: 30 * 60000,
    currentAudioUrl: 'blob:mock-current-track',
    currentMessageId: SOURCE_ID,
  });
  playCalls = 0;
  await usePlaybackStore.getState().playAudio('blob:mock-next-track', SOURCE_ID);
  assert.strictEqual(playCalls, 0, '暂停窗口内自动 playAudio 不得调用 controller.play');
  assert.strictEqual(
    usePlaybackStore.getState().currentAudioUrl,
    'blob:mock-current-track',
    '暂停窗口内自动 playAudio 不得切换轨道',
  );
  console.log('PASS: H-07-04-auto paused-window-no-continue verified');
  // 用例四之二：同态下显式点播必须放行并切轨。
  playCalls = 0;
  await usePlaybackStore.getState().playAudio('blob:mock-next-track', SOURCE_ID, { explicit: true });
  assert.strictEqual(playCalls, 1, '暂停窗口内显式 playAudio 必须调用 controller.play 出声');
  assert.strictEqual(
    usePlaybackStore.getState().currentAudioUrl,
    'blob:mock-next-track',
    '暂停窗口内显式 playAudio 必须切换到新轨道',
  );
  console.log('PASS: H-07-04-explicit paused-window-explicit-continues verified');
  // 对照：播放态直调必须放行。
  usePlaybackStore.setState({ isPlaying: true });
  playCalls = 0;
  await usePlaybackStore.getState().playAudio('blob:mock-next-track', SOURCE_ID);
  assert.strictEqual(playCalls, 1, '播放态 playAudio 必须放行');
  // 对照：无轨道初始直调必须放行。
  resetStores();
  installController();
  usePlaybackStore.setState({
    isPlaying: false,
    remainingMs: 30 * 60000,
    totalAllowedMs: 30 * 60000,
    currentAudioUrl: null,
    currentMessageId: null,
  });
  playCalls = 0;
  await usePlaybackStore.getState().playAudio('blob:mock-first-track', SOURCE_ID);
  assert.strictEqual(playCalls, 1, '无轨道初始 playAudio 必须放行');
  console.log('PASS: H-07-04 playAudio-guard verified');

  // 用例五：暂停有轨态显式 playParagraph 必须出声（回归：显式点新卡不得被自动链守卫拦截）。
  console.log('--- H-07-05: 暂停窗口内显式 playParagraph 必须放行 ---');
  resetStores();
  installController();
  seedActiveStory();
  usePlaybackStore.setState({
    isPlaying: false,
    remainingMs: 30 * 60000,
    totalAllowedMs: 30 * 60000,
    currentAudioUrl: 'blob:mock-current-track',
    currentMessageId: SOURCE_ID,
  });
  synthRequests.length = 0;
  playCalls = 0;
  await usePlaybackProgressStore.getState().playParagraph(1, { explicit: true });
  assert.strictEqual(playCalls, 1, '暂停窗口内显式 playParagraph 必须调用 controller.play 出声');
  assert.notStrictEqual(
    usePlaybackStore.getState().currentAudioUrl,
    'blob:mock-current-track',
    '暂停窗口内显式 playParagraph 必须切换到新合成轨道',
  );
  console.log('PASS: H-07-05 paused-window-explicit-continues verified');

  // 用例六：暂停有轨态显式 replayFromStart 必须出声（重播键为显式入口）。
  console.log('--- H-07-06: 暂停窗口内显式 replayFromStart 必须放行 ---');
  resetStores();
  installController();
  seedActiveStory();
  usePlaybackStore.setState({
    isPlaying: false,
    remainingMs: 30 * 60000,
    totalAllowedMs: 30 * 60000,
    currentAudioUrl: 'blob:mock-current-track',
    currentMessageId: SOURCE_ID,
  });
  synthRequests.length = 0;
  playCalls = 0;
  await usePlaybackProgressStore.getState().replayFromStart();
  assert.strictEqual(playCalls, 1, '暂停窗口内显式 replayFromStart 必须调用 controller.play 出声');
  console.log('PASS: H-07-06 paused-window-replay-continues verified');

  console.log('\nALL H-07 PARAGRAPH-GUARD TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runH07Tests()
  .then(() => {
    console.log('ALL H-07 PARAGRAPH-GUARD TEST CASES PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  })
  .finally(() => {
    // 中文注释：恢复全局打桩，避免污染后续套件。
    globalThis.fetch = originalFetch;
    try {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
        writable: true,
      });
    } catch {
      // 中文注释：重定义失败则忽略，测试进程即将结束。
    }
    if (originalCreateObjectURL) {
      urlStatics.createObjectURL = originalCreateObjectURL;
    } else {
      delete urlStatics.createObjectURL;
    }
  });

export default testPromise;
