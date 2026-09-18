/**
 *  PlaybackSessionFlow（spec §27， 收官运行时编排唯一入口）。
 *
 * Audio 事件 → 播放决策的唯一编排层：
 * beginPlayback / resumePlayback / playParagraph / handleNearEnd /
 * handleEnded / pause / restart / promoteDraftToWork / stop。
 *
 * AudioControllerHost 只报告 audio events（unlock/play/pause/resume/seek/
 * rate/timeupdate/ended 的 transport ownership 仍在 Host），本 flow 决定
 * segment / continuation / checkpoint。Host 不再直接 import ChatStore /
 * PreloadStore / PlaybackProgressStore / storyFlow 领域逻辑（§26.1）。
 *
 * Continuation 统一（§28）：本文件是续写判定的唯一位置，
 * `continuationMode === 'extendable'` 才允许 AI continuation，
 * 否则播完现有 paragraphs → ended。旧 isOneShot / sourceId guard /
 * currentMessageId guard 组合已退役，本文件一律不读取它们。
 *
 * Stale async TTS 保护（§50）：synth/fetchAudio 返回在
 * stores/playbackSessionStore 以 originatingSessionId 校验后才 play()，
 * 失配直接 revoke blob / discard；legacy 合成路径见 storyFlow 同名守卫。
 *
 *  Work canonical read（spec §22–§23）：本 flow 不直接选音源，
 * 仅经 store.playParagraph/prefetchNextParagraph 委托（lookahead 仍=1）；
 * store 内 Work+flag 开启 → ensureSegment → ready playbackUrl，
 * stale（sessionId 失配）绝不播放 A；Draft 恒旧路径；promotion 不打断当前 Blob。
 *
 * storyFlow.ts 回到故事生成流程兼容层；其中播放 session / preload / ended
 * 逻辑已迁出，此处为过渡期唯一兼容 fallback：无 session 的 legacy 音频
 *（未经理 Session SSOT 的旧 oneShot 链）仍委托 storyFlow 处理， 删除。
 * extendable 会话尾段是唯一允许回退 legacy AI 续写链的例外（§28）。
 */

import { usePlaybackStore, clampSegmentSeekTarget } from '@/stores/playbackStore';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import { useConfigStore } from '@/stores/configStore';
import { useContinuousCreationStore } from '@/stores/continuousCreationStore';
import { resolvePlaybackDraftSnapshot } from '@/lib/client/playbackDraftSnapshot';
import {
  computeStoryContentHash,
  normalizeStoryText,
  segmentStoryText,
} from '@/utils/segmentation';
import { isValidDraftMessageId, isValidWorkId } from '@/lib/playback/source';
import type { PlaybackSourceRef } from '@/lib/playback/source';
import type { SessionContinuationMode } from '@/stores/playbackSessionStore';
import type { SleepTimerMode } from '@/lib/playback/sleepTimer';

/** 可播放段落（legacy fallback 透传形态，与 storyFlow.PlayableSegment 同形）。 */
export type SessionPlayableSegment = {
  audioUrl: string;
  segment: string;
  messageId?: string;
};

/** 开始播放（新会话 / 切换 source / restart 统一经 Session API）。 */
export async function beginPlayback(params: {
  source: PlaybackSourceRef;
  mode: 'resume' | 'restart';
  speed?: number;
  draftSnapshot?: { title: string; contentHash: string; totalParagraphs: number; voiceId: string };
}): Promise<void> {
  await usePlaybackSessionStore.getState().beginPlayback(params);
}

/** 恢复已水合的断点（§25.5 Ready → 合成当前 paragraph → play）。 */
export async function resumePlayback(): Promise<void> {
  await usePlaybackSessionStore.getState().resumeRehydratedPlayback();
}

/** 播放指定段落（带 session guard，TTS 晚到丢弃见 store）。 */
export async function playParagraph(
  paragraphIndex: number,
  options?: { explicit?: boolean },
): Promise<void> {
  await usePlaybackSessionStore.getState().playParagraph(paragraphIndex, options);
}

/**
 * Continuation 统一判定（§28 纯判定，不触 store/网络）：
 * 仅 `extendable` 允许触发 AI continuation，其余一律播完现有段落 → ended。
 * @param mode 当前会话续写模式
 * @returns 是否允许 AI 续写
 */
export function shouldAllowAiContinuation(mode: SessionContinuationMode): boolean {
  return mode === 'extendable';
}

/**
 * 物理停重入 guard：AudioControllerHost.pause 会经 pauseViaSessionFlow 回调本函数，
 * 置位期间跳过二次物理停，避免互调死循环（幂等 1 次物理停 + 幂等逻辑停）。
 */
let physicalPauseReentry = false;

/** 显式暂停（transport 逻辑停 + 音频物理停 + checkpoint debounce）。 */
export function pausePlayback(): void {
  try {
    usePlaybackStore.getState().pause();
  } catch {
    // transport 暂停失败不阻断 session 侧 checkpoint。
  }
  try {
    usePlaybackSessionStore.getState().handleExplicitPause();
  } catch {
    // ignore
  }
  if (!physicalPauseReentry) {
    physicalPauseReentry = true;
    try {
      // 声画一致：显式暂停必须停住物理播放（否则 paused=false 的 audio 会继续播到段尾、
      // 触发 ended → 段落推进）；无 controller 时 no-op（幂等）。
      usePlaybackStore.getState().audioController?.pause();
    } finally {
      physicalPauseReentry = false;
    }
  }
}

/** 从头重播（§30 restart 语义由 server + store 持有）。 */
export async function restartPlayback(): Promise<void> {
  await usePlaybackSessionStore.getState().restart();
}

/**
 *  StoryCard / History 用户播放入口（Active Playback Session Visibility Closure）。
 *
 * 全局 invariant：任何用户可感知的故事播放开始时，都必须已经存在正式
 * Playback Session（`Transport.play()` 被调用时 `source !== null &&
 * status !== 'idle'` 恒成立）。业务 UI（StoryCard / GenerationHistory /
 * autoplay）一律经本节入口，不得再直接调用 `playbackStore.playAudio()` 做
 * 播放决策（Transport 仍是正式底层 API，仅由 Session/Flow 调用）。
 *
 * Legacy `part.audioUrl` 在此面被有意忽略：它没有 segment identity
 *（segmentIndex / textHash / segmentationVersion），无法证明代表整篇还是某
 * 正式 paragraph；若当 paragraph 0 播放，整篇播完后 Session 会继续推进
 * paragraph 1 造成重复播放。正确优先级：Session identity / segmentation
 * 正确 > 复用旧音频缓存（未来复用需另立 audio→segment identity 契约）。
 */

/** StoryCard 播放上下文：组件只交稳定 identity + 卡片上下文，不做播放决策。 */
export type StoryCardPlayInput = {
  /** 卡片所属 assistant 消息 id（Draft identity 唯一来源）。 */
  messageId: string;
  /** 卡片自带正文（仅当 canonical resolver 取不到快照时 fallback）。 */
  storyText?: string;
  /** 卡片/Artifact 自带标题（可选；缺省按 § 首行规则派生）。 */
  title?: string;
  /** 卡片自带 voice（可选；缺省用当前配置）。 */
  voiceId?: string;
};

/** Draft begin 所需集中式 metadata（§：Flow/domain helper 唯一构造点）。 */
export type StoryCardDraftMetadata = {
  source: Extract<PlaybackSourceRef, { kind: 'draft' }>;
  /** 规范化后正文（hash/切分严格基于此串）。 */
  storyText: string;
  paragraphs: string[];
  contentHash: string;
  totalParagraphs: number;
  title: string;
  voiceId: string;
  speed: number;
  /** server draft begin 快照（与本地 paragraphs 同源）。 */
  draftSnapshot: { title: string; contentHash: string; totalParagraphs: number; voiceId: string };
};

/** Draft 标题派生（纯函数）：首个非空行，去空白折叠后至多 60 字。 */
export function deriveDraftTitle(normalizedText: string): string {
  const firstLine = String(normalizedText ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find((line) => line.length > 0) ?? '';
  const sliced = firstLine.slice(0, 60);
  return sliced.length > 0 ? sliced : '未命名故事';
}

function pickNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : null;
}

/**
 * 集中构造 Draft begin metadata（ 唯一构造点；StoryCard/ChatLayout 不得各自定义）。
 * @returns 合法 metadata；任何非法输入（坏 messageId / 无可用正文 / 空切分）一律 null（fail-closed）。
 */
export function buildStoryCardDraftMetadata(input: StoryCardPlayInput): StoryCardDraftMetadata | null {
  const messageId = typeof input.messageId === 'string' ? input.messageId : '';
  if (!isValidDraftMessageId(messageId)) return null;
  let snapshotTitle: string | null = null;
  let snapshotVoice: string | null = null;
  let snapshotText: string | null = null;
  try {
    const snapshot = resolvePlaybackDraftSnapshot(messageId);
    snapshotText = snapshot && pickNonEmptyString(snapshot.storyText);
    snapshotTitle = snapshot ? pickNonEmptyString(snapshot.title) : null;
    snapshotVoice = snapshot ? pickNonEmptyString(snapshot.voiceId) : null;
  } catch {
    snapshotText = null;
  }
  const rawText = snapshotText ?? pickNonEmptyString(input.storyText);
  if (rawText === null) return null;
  const storyText = normalizeStoryText(rawText);
  if (storyText.length === 0) return null;
  const paragraphs = segmentStoryText(storyText);
  if (paragraphs.length === 0) return null;
  const contentHash = computeStoryContentHash(storyText);
  if (contentHash.length === 0) return null;
  const totalParagraphs = Math.max(1, paragraphs.length);
  let configVoice = '';
  let configSpeed = 1.0;
  try {
    const apiConfig = useConfigStore.getState().apiConfig;
    configVoice = typeof apiConfig.voiceId === 'string' ? apiConfig.voiceId : '';
    configSpeed = typeof apiConfig.speed === 'number' && Number.isFinite(apiConfig.speed) ? apiConfig.speed : 1.0;
  } catch {
    // 配置不可用时用安全缺省（playParagraph 侧仍有 voice 回退）。
  }
  const title = (pickNonEmptyString(input.title) ?? snapshotTitle ?? deriveDraftTitle(storyText)).slice(0, 100);
  const voiceId = (pickNonEmptyString(input.voiceId) ?? snapshotVoice ?? configVoice ?? '').slice(0, 64);
  return {
    source: { kind: 'draft', messageId },
    storyText,
    paragraphs,
    contentHash,
    totalParagraphs,
    title: title.length > 0 ? title : '未命名故事',
    voiceId,
    speed: configSpeed,
    draftSnapshot: {
      title: (title.length > 0 ? title : '未命名故事'),
      contentHash,
      totalParagraphs,
      voiceId,
    },
  };
}

/**
 * post-begin source-match 守卫（§50 切卡竞态）：
 * begin 返回后若当前 Session 已不是本次请求的 source（更新的切换已落地），
 * 调用方必须 abort，不得再 playParagraph（否则旧会话抢回 Transport）。
 */
function isCurrentSource(source: PlaybackSourceRef): boolean {
  const current = usePlaybackSessionStore.getState().source;
  if (!current || current.kind !== source.kind) return false;
  return source.kind === 'draft'
    ? (current as { messageId?: string }).messageId === source.messageId
    : (current as { workId?: number }).workId === source.workId;
}

/** 当前 Session 是否就是给定 source（同卡/同 Work）。 */
function isSameSource(
  session: { source: PlaybackSourceRef | null },
  source: PlaybackSourceRef,
): boolean {
  if (!session.source || session.source.kind !== source.kind) return false;
  return source.kind === 'draft'
    ? (session.source as { messageId: string }).messageId === source.messageId
    : (session.source as { workId: number }).workId === source.workId;
}

/**
 * 用户播放入口串行临界区 + 请求代（ §50 竞态收口）。
 *
 * 为什么需要：`beginPlayback` 内部会 `hydrateFromAnchor` 并直接 `set(source)`，
 * 而 store 的水合是「最后写入者胜出」。若两次 begin 并发，旧请求的晚到 hydrate
 * 可能覆盖新请求的 source（用户点了 A 再点 B，结果 A 出声）。因此所有
 *「决策 + begin」经同一串行链执行，并以单调递增的请求代判定最新意图：
 * 只有最新代可以 begin；begin 之后若代已过期，旧请求立即 abort（不 play）。
 * 这样最终 source/播放属于最后一次用户操作，且不会出现双路 begin 抢写。
 *
 * 起播（playParagraph）在临界区之外执行：切卡时新卡不必等待旧卡在途的 TTS
 * 合成；旧卡合成晚到由 store 的 originatingSessionId 守卫丢弃（§50）。
 */
let playRequestSeq = 0;
let playCriticalSection: Promise<unknown> = Promise.resolve();

/** 临界区计划：null = 已处理完（pause/resume/restart/被新请求取代），无需再起播。 */
type PlannedPlay =
  | { source: PlaybackSourceRef; sessionId: string | null; nextIndex: number | null }
  | null;

function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = playCriticalSection.then(fn, fn);
  playCriticalSection = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 同 source 的按钮意图（与旧 StoryCard 展示语义 1:1，只看 Transport 出声态）。 */
function planSameSourceIntent(
  session: { status: string; nextParagraphIndex: number; totalParagraphs: number },
  transport: { isPlaying: boolean },
): 'pause' | 'restart' | 'resume' {
  if (transport.isPlaying) return 'pause';
  if (session.status === 'ended' || session.nextParagraphIndex >= session.totalParagraphs) {
    return 'restart';
  }
  return 'resume';
}

/**
 * 临界区外的起播（二次校验）：
 * 期间若有更新请求接管 Session（sessionId/source 已变），本计划作废，不得起播。
 */
async function playPlanned(planned: PlannedPlay): Promise<void> {
  if (!planned || planned.nextIndex === null) return;
  if (
    planned.sessionId !== null &&
    usePlaybackSessionStore.getState().sessionId !== planned.sessionId
  ) {
    return;
  }
  if (!isCurrentSource(planned.source)) return;
  await playParagraph(planned.nextIndex, { explicit: true });
}

/**
 * StoryCard 正式播放入口（ 唯一 StoryCard 播放决策面）。
 *
 * - 当前 Session 就是该 Draft 且 Transport 正在出声 → 正式 pause；
 * - 就是该 Draft 且 `ended`（或 next 越界） → 正式 restart（新 sessionId）；
 * - 就是该 Draft（ready/paused，含合法未完成断点 `0<next<total`）→ `resumePlayback()`，
 *   保持 sessionId 与 canonical next（TTS 只合成 `paragraphs[next]`）；
 * - 无 Session 或另一张卡 → 新建 Draft Session（restart+新 UUID）再从正式起点起播。
 * 并发/连击时只有最后一次用户操作落地（见上方请求代说明）。
 * 不在 StoryCard/ChatLayout/storyFlow 复制第二套 Session/断点状态机。
 */
export async function playStoryCard(input: StoryCardPlayInput): Promise<void> {
  const messageId = typeof input.messageId === 'string' ? input.messageId : '';
  if (!isValidDraftMessageId(messageId)) return;
  const meta = buildStoryCardDraftMetadata(input);
  if (!meta) return;
  const token = ++playRequestSeq;
  const planned = await runSerialized(async (): Promise<PlannedPlay> => {
    if (token !== playRequestSeq) return null;
    const session = usePlaybackSessionStore.getState();
    const transport = usePlaybackStore.getState();
    if (isSameSource(session, meta.source)) {
      const intent = planSameSourceIntent(session, transport);
      if (intent === 'pause') {
        pausePlayback();
        return null;
      }
      if (intent === 'restart') {
        await restartPlayback();
        return null;
      }
      await resumePlayback();
      return null;
    }
    await beginPlayback({
      source: meta.source,
      mode: 'restart',
      speed: meta.speed,
      draftSnapshot: meta.draftSnapshot,
    });
    if (token !== playRequestSeq) return null;
    if (!isCurrentSource(meta.source)) return null;
    const live = usePlaybackSessionStore.getState();
    return { source: meta.source, sessionId: live.sessionId, nextIndex: live.nextParagraphIndex };
  });
  await playPlanned(planned);
}

/**
 * 正式 Work 播放入口（中性命名：Chat 创作卡、作品集详情、连续创作共用）。
 *
 * Work 底层即 StoryWork（`workId` = Work identity），回放走正式
 * Work Session：`source = {kind:'work', workId}`，经 Work
 * begin/restart/play 路径 + 正式 provider，finite（不触发 AI continuation）。
 * 不得伪造 transient Draft，不得修改 source union。
 *
 * 并发/连击经上方同一串行临界区 + 请求代收口：只有最后一次用户操作落地，
 * 不会并发创建多个服务端 begin 请求。
 */
export async function playStoryWork(workId: number): Promise<void> {
  if (!isValidWorkId(workId)) return;
  const source: PlaybackSourceRef = { kind: 'work', workId };
  const token = ++playRequestSeq;
  const planned = await runSerialized(async (): Promise<PlannedPlay> => {
    if (token !== playRequestSeq) return null;
    const session = usePlaybackSessionStore.getState();
    const transport = usePlaybackStore.getState();
    if (isSameSource(session, source)) {
      const intent = planSameSourceIntent(session, transport);
      if (intent === 'pause') {
        pausePlayback();
        return null;
      }
      if (intent === 'restart') {
        await restartPlayback();
        return null;
      }
      await resumePlayback();
      return null;
    }
    let speed = 1.0;
    try {
      const configSpeed = useConfigStore.getState().apiConfig.speed;
      if (typeof configSpeed === 'number' && Number.isFinite(configSpeed)) speed = configSpeed;
    } catch {
      // 缺省 1.0。
    }
    await beginPlayback({ source, mode: 'restart', speed });
    if (token !== playRequestSeq) return null;
    if (!isCurrentSource(source)) return null;
    const live = usePlaybackSessionStore.getState();
    return { source, sessionId: live.sessionId, nextIndex: live.nextParagraphIndex };
  });
  await playPlanned(planned);
}

/**
 * @deprecated 历史命名兼容别名：与 `playStoryWork` 同一实现。
 * 范围外调用方（作品集详情等）迁移前保留；待无调用方后由后续段删除。
 * 本段新代码一律使用 `playStoryWork`。
 */
export const playWorkFromHistory = playStoryWork;

/**
 * 生成完成后 autoplay 正式入口（）。
 * 恒 fresh-restart 建 Draft Session 再从 `paragraphs[0]` 起播（旧整篇 blob 不得
 * 当 paragraph 播放，由调用方吊销）。transport 可能残留旧轨道，故恒 explicit。
 */
export async function autoplayDraftStory(input: StoryCardPlayInput): Promise<void> {
  const messageId = typeof input.messageId === 'string' ? input.messageId : '';
  if (!isValidDraftMessageId(messageId)) return;
  const meta = buildStoryCardDraftMetadata(input);
  if (!meta) return;
  const token = ++playRequestSeq;
  const planned = await runSerialized(async (): Promise<PlannedPlay> => {
    if (token !== playRequestSeq) return null;
    await beginPlayback({
      source: meta.source,
      mode: 'restart',
      speed: meta.speed,
      draftSnapshot: meta.draftSnapshot,
    });
    if (token !== playRequestSeq) return null;
    if (!isCurrentSource(meta.source)) return null;
    const live = usePlaybackSessionStore.getState();
    return { source: meta.source, sessionId: live.sessionId, nextIndex: 0 };
  });
  await playPlanned(planned);
}

/**
 *   当前 Segment seek（spec §17/§17.1/§17.3 additive，无新 SSOT）。
 * 只动 Transport 段内 currentTime（经 AudioControllerHost 唯一 audio owner），
 * 不改变 Session sessionId/source/paragraph identity，不落 checkpoint。
 * 全 clamp + duration=0/unknown fail-safe（no-op 返回 false）。
 * @param targetSeconds 目标秒数
 * @returns 是否实际发起 seek
 */
export function seekCurrentSegment(targetSeconds: number): boolean {
  const transport = usePlaybackStore.getState();
  const clamped = clampSegmentSeekTarget(targetSeconds, transport.duration);
  if (clamped === null) {
    return false;
  }
  transport.seekAudio(clamped);
  return true;
}

/**
 *   相对 seek（keyboard ±5s，spec §17.2）。
 * currentTime + delta 后走同一 clamp/fail-safe；不改变 Session identity。
 * @param deltaSeconds 相对秒数（+5/-5）
 * @returns 是否实际发起 seek
 */
export function seekRelative(deltaSeconds: number): boolean {
  if (typeof deltaSeconds !== 'number' || !Number.isFinite(deltaSeconds)) {
    return false;
  }
  const transport = usePlaybackStore.getState();
  return seekCurrentSegment(transport.currentTime + deltaSeconds);
}

/**
 *   当前 Session 倍速（spec §20/§20.1 additive，无新 SSOT）。
 * Session.speed + Transport.playbackRate + Anchor 持久化三同步；
 * 不写回 UserConfig 默认 speed；不触发新 TTS（只调 <audio>.playbackRate）。
 * @param rate 目标倍速（旧七档之一；越界/非法直接 no-op）
 */
export async function setPlaybackRate(rate: number): Promise<void> {
  await usePlaybackSessionStore.getState().setSpeed(rate);
}

/**
 *   当前 Session Sleep Timer 设置（spec §24 additive，无新 SSOT）。
 * 只改当前 Session Timer（经 playback.setSleepTimer 独立持久化），不自动改
 * Settings 默认（§31.1）；stale（Session 已切换）返回 false（§24.1）。
 * UI 只经此入口，不得直接操作 <audio> / Session 字段（评审约束 10）。
 * @param mode 三态（story_end 仅 Work；Draft 由 Session 侧拒绝返回 false）
 * @param minutes mode==minutes 时必填（10–120）
 * @returns 是否设置成功（stale/非法返回 false）
 */
export async function setSleepTimer(mode: SleepTimerMode, minutes?: number): Promise<boolean> {
  return usePlaybackSessionStore.getState().setSleepTimer(mode, minutes);
}

/**
 *  Sleep Timer 到期承接（spec §26）。
 * Transport 到期已 pause audio + 归一 off/null；此处承接 Session paused +
 * checkpoint 持久化 + Toast。Session 保留 paused，之后 Play 正常继续。
 */
export async function handleSleepTimerExpired(): Promise<void> {
  await usePlaybackSessionStore.getState().handleSleepTimerExpired();
}

/**
 *  到期回调注册（AudioControllerHost 挂载时调用，卸载时传 null 解除）。
 * Transport 到期（非 minutes 不触发）经此回调进入 Flow 编排，
 * Transport 本身不 import Session（防循环依赖）。
 */
export function registerSleepTimerExpiryHandler(): void {
  try {
    usePlaybackStore.getState().registerSleepTimerExpiryHandler(() => {
      void handleSleepTimerExpired();
    });
  } catch {
    // 注册失败不阻断 Host 挂载（到期仅缺 Toast/checkpoint，audio 照停）。
  }
}

/** Draft→Work 提升（§24，sessionId 不变，hash 不一致 reset 0）。 */
export async function promoteDraftToWork(workId: number): Promise<void> {
  await usePlaybackSessionStore.getState().promoteDraftToWork(workId);
}

/** 停止（本地停驻，不清 server Anchor；显式清理请用 clear）。 */
export function stopPlayback(): void {
  usePlaybackSessionStore.getState().stop();
}

/**
 * §27 规范名别名（与 spec 动词一致；pausePlayback / restartPlayback /
 * stopPlayback 保留供 Host 等既有调用方， 再收敛命名）。
 *  增补 restartCurrentSession（spec §47/ 对  additive contract 命名统一，
 * 同一 restart 实现，不新增重复状态）。
 */
export { pausePlayback as pause, restartPlayback as restart, stopPlayback as stop };
export { restartPlayback as restartCurrentSession };

/** 播放器开始播放时更新 transport 倒计时。 */
export function reportPlaybackStart(): void {
  usePlaybackStore.getState().start();
}

/** 播放器暂停时同步 transport。 */
export function reportPlaybackPause(): void {
  usePlaybackStore.getState().pause();
}

/**
 *  fixup（复审 / §25.1）：Host 上报音频“实际推进”运行时信号
 *（playing → true；waiting / stalled / pause / ended → false）。
 * 仅用于 sleep timer countdown 门使 buffering 不计入“再听 N 分钟”，不改变 Session 语义状态。
 */
export function reportAudioActive(active: boolean): void {
  usePlaybackStore.getState().reportAudioActive(active);
  // 同一 audio-active 信号驱动连续创作预算；动态 import 避免模块环。
  void import('./continuousCreationFlow')
    .then((flow) => flow.reportContinuousAudioActive(active))
    .catch(() => undefined);
}

/** 播放进度推进（供 timeupdate/loadedmetadata 复用）。 */
export function reportProgress(payload: { currentTime: number; duration: number }): void {
  usePlaybackStore.getState().updateProgress(payload);
  //  单轨：duration 已知后一次性应用服务端恢复位（内部 duration>0 守卫 + 幂等）。
  usePlaybackSessionStore.getState().applyPendingSingleTrackResume(payload.duration);
  //  单轨：常规 timeupdate 机会式落库（client 10s 节流；暂停/完播走 force）。
  void usePlaybackSessionStore.getState().persistSingleTrackProgress();
}

/**
 * near-end 预载决策（§27/§28）：
 * - 有 session source：finite 一律仅段落级推进，绝不走聊天续写（§28 唯一门）；
 *   仅 extendable 允许回退 legacy AI 续写链（过渡期， 删除）；
 * - 无 session（legacy 音频）：委托 storyFlow.handleNearEnd 兼容（ 删除）。
 */
export async function handleNearEnd(): Promise<void> {
  const session = usePlaybackSessionStore.getState();
  // §28 唯一门：有 session 且 finite → 不续写聊天；  改为走连续创作
  // 预生成下一作品（lookahead=1，窗口/预算/开关由状态机守卫）。
  if (
    session.source &&
    session.totalParagraphs > 0 &&
    !shouldAllowAiContinuation(session.continuationMode)
  ) {
    const { scheduleContinuousNextWork } = await import('@/app/services/continuousCreationFlow');
    await scheduleContinuousNextWork();
    return;
  }
  // 到达此处仅两种情形：无 session 的 legacy 音频，或 extendable 会话尾段
  //（唯一允许 AI continuation 的例外）；二者皆走 legacy 聊天续写链（ 删除）。
  const { handleNearEnd: legacyNearEnd } = await import('@/app/services/storyFlow');
  await legacyNearEnd();
}

/**
 * timeupdate 上报 + 自适应 near-end 调度（Host 唯一调用点）。
 * @returns void（预载失败仅日志，不抛错中断播放）
 */
export function reportTimeUpdate(payload: {
  currentTime: number;
  duration: number;
  hasTriggeredPreload: { current: boolean };
}): void {
  reportProgress({ currentTime: payload.currentTime, duration: payload.duration });
  const { currentTime, duration } = payload;
  if (!(duration > 0)) return;
  const remaining = duration - currentTime;
  const adaptiveThreshold = Math.min(10, Math.max(5, duration * 0.25));
  if (remaining > adaptiveThreshold) return;
  if (payload.hasTriggeredPreload.current) return;
  if (!usePlaybackStore.getState().isPlaying) return;

  const session = usePlaybackSessionStore.getState();
  if (session.source && session.totalParagraphs > 1 && session.nextParagraphIndex + 1 < session.totalParagraphs) {
    // 非尾段：段落级预载（lookahead=1，续写模式无关——预载已定段落不是 AI 续写）。
    payload.hasTriggeredPreload.current = true;
    void session.prefetchNextParagraph(session.nextParagraphIndex + 1).catch((error) => {
      console.error('段落预加载失败:', error);
    });
    return;
  }
  if (session.source && session.totalParagraphs > 0) {
    // 有 session 的尾段/单段：§28 唯一门——finite 不续写聊天；  改为
    // 触发连续创作预生成（lookahead=1，状态机自守卫；未进窗/已有 next job 则 no-op）。
    if (!shouldAllowAiContinuation(session.continuationMode)) {
      payload.hasTriggeredPreload.current = true;
      void import('@/app/services/continuousCreationFlow')
        .then((flow) => flow.scheduleContinuousNextWork())
        .catch((error) => {
          console.error('连续创作调度下一作品失败:', error);
        });
      return;
    }
  }
  // 无 session legacy，或 extendable 会话尾段：走旧 near-end
  //（legacy 内部自带 budget/Preload 锁；session 归属由其首部守卫复核）。
  payload.hasTriggeredPreload.current = true;
  handleNearEnd().catch((error) => {
    console.error('预加载下一段音频失败:', error);
  });
}

/**
 * ended 决策（§27/§28）：
 * - 有 session source：非尾段一律走段落推进；尾段 finite 直接收尾
 *（播完现有 paragraphs → ended，严禁聊天续写），仅 extendable 尾段允许
 *   先试 legacy AI 续写链，取不到新段才收尾；
 * - 无 session（legacy 音频）：委托 storyFlow.handleSegmentEnded 兼容，返回可播段则由调用方播放。
 * @param play 播放函数（Host 传入的 transport play，用于 legacy fallback 段播放）
 * @returns continued=true 表示已自动推进下一段（调用方直接返回）
 */
export async function handleEnded(play: (audioUrl: string, messageId?: string) => Promise<void>): Promise<boolean> {
  const session = usePlaybackSessionStore.getState();
  if (session.source && session.totalParagraphs > 0) {
    // 单轨 Work 整轨只有一个 Asset，任意物理 ended 都代表「整 track 播完」，
    // 必须走尾段分支（先试连续创作下一 Work，再整 Work 完播），不得按段落推进。
    // Draft 仍按段落索引判定尾段。
    const isWorkSingleTrack = session.source?.kind === 'work';
    const atTail = isWorkSingleTrack || session.nextParagraphIndex + 1 >= session.totalParagraphs;
    if (!atTail) {
      // 非尾段：会话段落机推进，不碰连续创作。
      return await session.handleParagraphEnded();
    }
    if (!shouldAllowAiContinuation(session.continuationMode)) {
      // finite 整轨结束 → 连续创作正式交接：next_ready 原子取出并经
      // playStoryWork 续播；在途则进入 waiting_next（准备完成后自动续播）；
      // error/终态保持当前页面（绝不复活旧结果）。
      const epoch = useContinuousCreationStore.getState().epoch;
      const { handleTrackEnded } = await import('@/app/services/continuousCreationFlow');
      const continued = await handleTrackEnded(epoch);
      if (continued) {
        return true;
      }
      return await session.handleParagraphEnded();
    }
    // extendable 尾段（唯一例外）：先试 legacy AI 续写链，取不到才收尾。
    const { handleSegmentEnded } = await import('@/app/services/storyFlow');
    const nextSegment: SessionPlayableSegment | null = await handleSegmentEnded();
    if (!nextSegment) {
      const continued = await session.handleParagraphEnded();
      return continued;
    }
    await play(nextSegment.audioUrl, nextSegment.messageId);
    return true;
  }
  const { handleSegmentEnded } = await import('@/app/services/storyFlow');
  const nextSegment: SessionPlayableSegment | null = await handleSegmentEnded();
  if (!nextSegment) return false;
  await play(nextSegment.audioUrl, nextSegment.messageId);
  return true;
}
