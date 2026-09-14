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

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const toastCapture = createToastCapture();
installGlassToastStub(toastCapture);

// 中文注释：fetchAudio 可编程桩（捕获 TTS 输入文本，证明 M5 resume 只合成单段）。
// 必须在任何 store/flow 被求值之前劫持 require 缓存。
const ttsInputs: string[] = [];
let fetchCalls = 0;
const ttsPath = path.resolve(process.cwd(), 'lib/client/ttsGenerate.ts');
nodeRequire.cache[ttsPath] = {
  id: ttsPath,
  filename: ttsPath,
  loaded: true,
  exports: {
    fetchAudio: async (text: string): Promise<string> => {
      fetchCalls += 1;
      ttsInputs.push(text);
      return `blob:mock-storycard-${fetchCalls}`;
    },
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
const getFlow = () =>
  nodeRequire('../../../app/services/playbackSessionFlow') as typeof import('../../../app/services/playbackSessionFlow');
const getStoryFlow = () =>
  nodeRequire('../../../app/services/storyFlow') as typeof import('../../../app/services/storyFlow');

/**
 * M9-03 fixup StoryCard resume 走 M5 Session Flow（L1 oracle，替代已删旧 store 实现测试）。
 *
 * 用户级语义（裁决逐字对齐）：
 * - Draft Session（messageId=卡片 messageId、paragraphs=4、next=2）→ 卡片显示“从第 3 段继续收听”；
 *   点击必须经 M5 resume/playParagraph；TTS 输入=paragraphs[2]（不得把完整 storyText 作一次 TTS 输入）；
 *   sessionId 不变；按钮断点与 next identity 同源（同读 Session SSOT nextParagraphIndex）。
 * - ended 防错：next==total 时 UI 与 action 一致不显示/不走 resume（next>0 AND next<total）。
 * - fresh/no-session：无匹配 Session → legacy restored card 仍允许从头 one-shot 重合成（历史卡兼容保留）。
 * - action 层分流静态锁：M5 拥有决策；无 Session 才走 storyFlow transport fallback；断点逻辑不得回塞 playStoryText。
 */

const MESSAGE_ID = 'msg_fixup_storycard_resume';
const FRESH_ID = 'msg_fixup_storycard_fresh';
const SESSION_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

const PARA1 =
  '第一自然段：很久很久以前，在宁静的大森林深处住着一只聪明活泼的小松鼠，它有一条蓬松的大尾巴，每天清晨都在高高的树梢间欢快地跳来跳去，寻找新鲜的坚果与甘甜的露水。';
const PARA2 =
  '第二自然段：小松鼠每天早晨迎着金色的朝阳出门收集松果，仔细辨别每一颗果实是否饱满香甜，并将它们整齐地存放在自己温暖干燥的树洞深处，准备迎接即将到来的寒冷冬天。它还会在洞口铺上柔软的干草。';
const PARA3 =
  '第三自然段：有一天它在一棵巨大的古老松树下发现了一颗闪闪发光的神奇松果，散发出奇异而温暖的柔和光芒，不仅照亮了周围湿漉漉的青苔，还散发出一种让人心情平静的香气。';
const PARA4 =
  '第四自然段：这颗发光的松果带领着好奇的小松鼠走进了森林最深处的奇妙花园，那里盛开着从未见过的美丽奇幻花朵，彩色的蝴蝶在花丛中翩翩起舞，宛如梦境一般美丽动人。小松鼠决定把这份喜悦分享给森林里的每一位朋友。';
const STORY_TEXT = `${PARA1}\n${PARA2}\n${PARA3}\n${PARA4}`;

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
  ttsInputs.length = 0;
  fetchCalls = 0;
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

/** 与 StoryCardPart.tsx 同源的 resume 判定（next > 0 AND next < total + draft messageId 精确匹配）。 */
function isDraftResumePoint(
  source: { kind: string; messageId?: string } | null,
  cardMessageId: string | undefined,
  next: number,
  total: number,
): boolean {
  return Boolean(
    cardMessageId &&
      source?.kind === 'draft' &&
      (source as { messageId?: string }).messageId === cardMessageId &&
      next > 0 &&
      next < total,
  );
}

async function runStorycardSessionResumeTests(): Promise<void> {
  console.log('=== M9-03 fixup: StoryCard resume via M5 session flow (unit oracle) ===');

  const expectedParagraphs = segmentStoryText(normalizeStoryText(STORY_TEXT));
  assert.strictEqual(expectedParagraphs.length, 4, '前置：故事正文必须切分为 4 段');

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

  // —— Draft Session case：next=2 → M5 resume 只合成 paragraphs[2] ——
  console.log('--- draft resume: next=2 → M5 playParagraph(paragraphs[2]) ---');
  resetPlaybackWorld();
  const playCalls: string[] = [];
  installFakeController(playCalls);
  const useSession = getSessionStore();
  const useTransport = getTransportStore();

  useSession.getState().setActiveStory({
    source: { kind: 'draft', messageId: MESSAGE_ID },
    sessionId: SESSION_ID,
    title: '小松鼠的故事',
    storyText: STORY_TEXT,
    voiceId: 'alloy',
    speed: 1,
    initialNextIndex: 2,
  });
  const s0 = useSession.getState();
  assert.deepStrictEqual(s0.source, { kind: 'draft', messageId: MESSAGE_ID });
  assert.strictEqual(s0.sessionId, SESSION_ID);
  assert.strictEqual(s0.paragraphs.length, 4, 'Session 段落必须为 4');
  assert.strictEqual(s0.totalParagraphs, 4);
  assert.strictEqual(s0.nextParagraphIndex, 2, '断点 next 必须为 2');
  assert.strictEqual(s0.paragraphs[2], expectedParagraphs[2]);

  // 按钮断点与 next identity 同源：同一 SSOT next 派生文案“从第 3 段继续收听”。
  const resumePoint = isDraftResumePoint(s0.source, MESSAGE_ID, s0.nextParagraphIndex, s0.totalParagraphs);
  assert.strictEqual(resumePoint, true, 'messageId 一致 + 2/4 未完成 → 必须为 resume 点');
  const buttonLabel = `从第 ${s0.nextParagraphIndex + 1} 段继续收听`;
  assert.strictEqual(buttonLabel, '从第 3 段继续收听', '按钮文案必须与 next 同源（next=2 → 第 3 段）');

  // 点击走 M5 正式链：resumePlayback → resumeRehydratedPlayback → playParagraph(next, explicit)。
  const sessionIdBefore = useSession.getState().sessionId;
  await getFlow().resumePlayback();
  assert.strictEqual(ttsInputs.length, 1, 'M5 resume 必须恰好合成一次');
  assert.strictEqual(
    ttsInputs[0],
    expectedParagraphs[2],
    'M5 resume 的 TTS 输入必须是 paragraphs[2]（不得把完整 storyText 作一次输入）',
  );
  assert.notStrictEqual(ttsInputs[0], STORY_TEXT, 'TTS 输入不得为完整 storyText');
  assert.strictEqual(useSession.getState().sessionId, sessionIdBefore, 'resume 不得新建 session（sessionId 不变）');
  assert.strictEqual(useSession.getState().sessionId, SESSION_ID);
  assert.strictEqual(useSession.getState().nextParagraphIndex, 2, 'resume 起点必须与按钮同源（next=2）');
  assert.strictEqual(playCalls.length, 1, 'transport 必须恰好播一次合成段');
  assert.strictEqual(useTransport.getState().currentAudioUrl, playCalls[0]);
  console.log('PASS: draft resume via M5 verified');

  // —— 错卡隔离：同 Session 下他卡 messageId 不得命中 resume ——
  console.log('--- mismatch messageId → not resume point ---');
  assert.strictEqual(
    isDraftResumePoint(s0.source, 'msg_other_card', s0.nextParagraphIndex, s0.totalParagraphs),
    false,
    '他卡 messageId 不得命中当前 draft 断点',
  );
  assert.strictEqual(
    isDraftResumePoint(s0.source, undefined, s0.nextParagraphIndex, s0.totalParagraphs),
    false,
    '缺 messageId 不得命中',
  );
  console.log('PASS: mismatch isolation verified');

  // —— ended 防错：next==total 时 UI 与 action 一致不走 resume ——
  console.log('--- ended guard: next==total → not resume ---');
  useSession.setState({ nextParagraphIndex: 4, status: 'ended' });
  const sEnded = useSession.getState();
  assert.strictEqual(sEnded.totalParagraphs, 4);
  assert.strictEqual(
    isDraftResumePoint(sEnded.source, MESSAGE_ID, sEnded.nextParagraphIndex, sEnded.totalParagraphs),
    false,
    'ended（next==total）不得再视为 resume 点',
  );
  assert.strictEqual(
    isDraftResumePoint(sEnded.source, MESSAGE_ID, 0, sEnded.totalParagraphs),
    false,
    'next==0 不得视为 resume 点',
  );
  console.log('PASS: ended guard verified');

  // —— fresh/no-session：无匹配 Session → legacy one-shot 重合成（历史卡兼容） ——
  console.log('--- fresh/no-session: legacy one-shot resynth from start ---');
  resetPlaybackWorld();
  const freshCalls: string[] = [];
  installFakeController(freshCalls);
  assert.strictEqual(useSession.getState().source, null, 'fresh 前置：无 Session');
  assert.strictEqual(
    isDraftResumePoint(null, FRESH_ID, 0, 1),
    false,
    '无 Session 不得命中 resume',
  );
  await getStoryFlow().playStoryText(STORY_TEXT, FRESH_ID);
  assert.strictEqual(ttsInputs.length, 1, 'fresh one-shot 必须恰好合成一次');
  assert.strictEqual(
    ttsInputs[0],
    STORY_TEXT,
    '无 Session 的 legacy restored card 允许从头 one-shot 重合成（完整 storyText 输入）',
  );
  assert.strictEqual(freshCalls.length, 1, 'fresh 合成后必须经 transport 播一次');
  assert.strictEqual(useSession.getState().source, null, 'legacy fallback 不得新建 M5 Session');
  console.log('PASS: fresh one-shot fallback verified');

  // —— action 层分流静态锁：M5 拥有决策，无 Session 才 fallback；断点不回塞 storyFlow ——
  console.log('--- static: StoryCard routes resume via M5, fallback only without session ---');
  const cardSource = fs.readFileSync(
    path.resolve(process.cwd(), 'app/(main)/chat/components/MessageParts/StoryCardPart.tsx'),
    'utf8',
  );
  const cardCode = stripComments(cardSource);
  assert.ok(!cardCode.includes('playbackProgressStore'), 'StoryCard 不得再读旧 progress store');
  assert.ok(cardCode.includes('usePlaybackSessionStore'), 'StoryCard resume 位必须经 Session SSOT');
  assert.ok(
    cardCode.includes("from '@/app/services/playbackSessionFlow'") ||
      cardCode.includes('from "@/app/services/playbackSessionFlow"'),
    'StoryCard 必须 import M5 playbackSessionFlow.resumePlayback（正式链）',
  );
  assert.ok(cardCode.includes('resumePlayback'), 'StoryCard action 层必须调用 resumePlayback');
  assert.ok(cardCode.includes('if (isThisCardResumePoint)'), 'handlePlay 必须以 isThisCardResumePoint 显式分流');
  assert.ok(
    cardCode.includes('sessionNextIndex > 0') && cardCode.includes('sessionNextIndex <'),
    'resume 判定必须补完整：next > 0 AND next < total（ended 防错）',
  );
  assert.ok(cardCode.includes('totalParagraphs'), '必须订阅 totalParagraphs 参与判定');
  assert.ok(cardCode.includes("kind === 'draft'"), '必须按 draft kind 分流');
  assert.ok(cardCode.includes('.messageId === messageId'), '必须按 messageId 精确匹配');
  assert.ok(
    cardCode.includes('sessionNextIndex + 1'),
    '按钮断点必须与 next identity 同源（sessionNextIndex + 1）',
  );
  assert.ok(cardCode.includes('从第'), '按钮必须保留“从第 N 段继续收听”文案');
  // UI 与 action 同源：同一 isThisCardResumePoint 同时驱动 handlePlay 分流与按钮三元。
  assert.ok(
    cardCode.includes('isThisCardResumePoint ?'),
    '按钮展示必须与 action 共用同一 isThisCardResumePoint（UI/action 一致）',
  );
  assert.ok(cardCode.includes('playStoryText'), '无 Session fallback 必须保留 playStoryText one-shot 路径');
  assert.ok(cardCode.includes('part.audioUrl'), '有 audioUrl 的 legacy 直接 transport 路径必须保留');
  // 禁止第二套决策回塞 storyFlow。
  const storySource = fs.readFileSync(
    path.resolve(process.cwd(), 'app/services/storyFlow.ts'),
    'utf8',
  );
  const storyCode = stripComments(storySource);
  const playStoryTextBlock = storyCode.slice(storyCode.indexOf('export const playStoryText'));
  assert.ok(playStoryTextBlock.length > 0, 'storyFlow 必须保留 playStoryText fallback');
  assert.ok(
    !playStoryTextBlock.includes('nextParagraphIndex'),
    '禁止把断点逻辑塞回 storyFlow.playStoryText（不得出现 nextParagraphIndex）',
  );
  assert.ok(
    !playStoryTextBlock.includes('resumePlayback') && !playStoryTextBlock.includes('resumeRehydratedPlayback'),
    'playStoryText 不得自建 resume 决策（唯一决策在 StoryCard action 层 + M5 flow）',
  );
  console.log('PASS: routing static guard verified');

  resetPlaybackWorld();
  console.log('\nALL STORYCARD SESSION RESUME TESTS PASSED!');
}

const testPromise = runStorycardSessionResumeTests()
  .then(() => {
    console.log('ALL STORYCARD SESSION RESUME TESTS PASSED!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;
