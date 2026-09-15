/**
 * M5-09 PlaybackSessionStore（spec §10 / §25 Client Session SSOT）。
 *
 * 新客户端会话唯一事实源：server 四表 + Anchor DTO 为持久化 SSOT，
 * 本 store 为运行时 SSOT。Work 路径按 workId 经 library.get 精确 resolve
 *（§25.1，严禁走 generationHistoryStore 最近 N 条 find(id) 旧路径）；
 * Draft 路径按 messageId 经 canonical resolver 取快照（Modern first、
 * Legacy 只读 fallback，见 lib/client/playbackDraftSnapshot），缺失清
 * dangling Anchor（§25.2 fail-closed）。Hash 统一 segmentation SSOT（§25.3），Title 变化
 * 只更新 title 不重置 progress（§25.4），成功后 status=ready + transport idle
 * 不 autoplay（§25.5）。
 *
 * continuation：一律 finite（§12，所有持久化 Anchor 重水合后视为 finite；
 * lib/playback/progress.ts resolveContinuationMode / rehydratedContinuationMode）。
 *
 * hydration 纪元：每次 init() 自增 epoch，过期异步 resolve 直接丢弃，
 * 不写回状态（防切源/TTS 晚到覆盖，见 spec §50 session guard）。
 *
 * M5-09 cutover：stores/accountSync 已切换到本 store；旧
 * stores/playbackProgressStore 已在 M9-03 删除，
 * 本文件绝不 import generationHistoryStore /
 * storyFlow / preloadStore（旧路径残留不得破坏新流程）。
 */

import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';
import GlassToast from '@/components/ui/GlassToast';
import type {
  GetPlaybackAnchorOutput,
  PlaybackAnchorDTO,
} from '@/lib/trpc/schemas/playback';
import {
  getPlaybackAnchor,
  beginPlaybackSession,
  savePlaybackCheckpoint,
  completePlaybackSession,
  clearPlaybackAnchor,
  promoteDraftPlaybackToWork,
  setSleepTimer as apiSetSleepTimer,
} from '@/lib/client/playbackSession';
import { get as getWorkDetail } from '@/lib/client/library';
import {
  SEGMENTATION_VERSION,
  computeStoryContentHash,
  normalizeStoryText,
  segmentStoryText,
} from '@/utils/segmentation';
import {
  decideRehydratedPosition,
  resolveRehydratedTitle,
} from '@/lib/playback/rehydrate';
import {
  rehydratedContinuationMode,
  resolvePromotedNextParagraphIndex,
  shouldPreserveDraftBreakpointOnPromote,
} from '@/lib/playback/progress';
import { createPlaybackSessionId, isValidPlaybackSessionId } from '@/lib/playback/session';
import type { PlaybackSourceRef } from '@/lib/playback/source';
import {
  resolveDefaultSessionTimer,
  type SleepTimerMode,
} from '@/lib/playback/sleepTimer';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useChatStore } from '@/stores/chatStore';
import { useConfigStore } from '@/stores/configStore';
import { fetchAudio } from '@/lib/client/ttsGenerate';
import {
  ensureAsset as ensureCanonicalAsset,
  ensureSegment as ensureCanonicalSegment,
  getPlaybackManifest as fetchPlaybackManifest,
  isCanonicalPlaybackUrl,
  isSingleTrackPlaybackUrl,
  selectWorkParagraphs,
  shouldUseCanonicalAudio,
} from '@/lib/client/storyAudio';
import { isSingleTrackAudioEnabled } from '@/lib/audio/singleTrackFlag';
import {
  resolvePlaybackDraftSnapshot,
  type PlaybackDraftSnapshot,
} from '@/lib/client/playbackDraftSnapshot';

/** §10 PlaybackSessionStatus（运行态 playing/synthesizing/error 不持久化）。 */
export type PlaybackSessionStatus =
  | 'idle'
  | 'hydrating'
  | 'ready'
  | 'synthesizing'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error';

/** §10 continuation：rehydrate 后一律 finite（§12 invariant）。 */
export type SessionContinuationMode = 'finite' | 'extendable';

interface PlaybackSessionState {
  sessionId: string | null;
  /** 新 SSOT source（discriminated union draft/work，替代旧 sourceType/sourceId 双写）。 */
  source: PlaybackSourceRef | null;
  title: string;
  storyText: string;
  paragraphs: string[];
  contentHash: string;
  segmentationVersion: string;
  lastCompletedParagraphIndex: number;
  nextParagraphIndex: number;
  totalParagraphs: number;
  voiceId: string;
  speed: number;
  continuationMode: SessionContinuationMode;
  status: PlaybackSessionStatus;
  /**
   * M7-03 当前 Session Sleep Timer 三态（spec §22；Anchor.sleepTimerMode 的运行时镜像）。
   * minutes 预算本体在 Transport（remainingMs/totalAllowedMs）；本字段决定 countdown 门与 UI 展示。
   */
  sleepTimerMode: SleepTimerMode;
  prefetchedAudioUrl: string | null;
  prefetchingIndex: number | null;
  lastSavedKey: string | null;
  /** hydration 纪元（每次 init 自增，过期 resolve 丢弃）。 */
  hydrationEpoch: number;
}

interface PlaybackSessionActions {
  /** §25 页面启动：getAnchor → resolve Source（hydration 纪元守卫）。 */
  init: (deps?: SessionRehydrateDeps) => Promise<boolean>;
  initForUser: (deps?: SessionRehydrateDeps) => Promise<boolean>;
  initForGuest: (deps?: SessionRehydrateDeps) => Promise<boolean>;
  /** 由 Anchor DTO 直接水合（init 内部与测试共用）。 */
  hydrateFromAnchor: (anchor: PlaybackAnchorDTO, deps?: SessionRehydrateDeps) => Promise<boolean>;
  /**
   * M7-02 P3A 当前 Session 倍速（spec §20/§20.1 additive，无新 SSOT）。
   * Session.speed + Transport.playbackRate + Anchor 持久化三同步；
   * 不写回 UserConfig 默认 speed；不触发新 TTS；不建 Expanded-local state。
   * 非法值（非有限/越界 0.25–4.0）直接忽略；无 source 时 no-op。
   */
  setSpeed: (rate: number) => Promise<void>;
  setActiveStory: (params: {
    source: PlaybackSourceRef;
    sessionId?: string | null;
    title: string;
    storyText: string;
    voiceId?: string;
    speed?: number;
    continuationMode?: SessionContinuationMode;
    remainingAllowedMs?: number | null;
    totalAllowedMs?: number | null;
    /**
     * M7-03 当前 Session Timer 三态（缺省按 User Config 默认解析，§28；
     * 显式传入时与 remaining/total 一致性由调用方保证）。
     */
    sleepTimerMode?: SleepTimerMode;
    initialNextIndex?: number;
  }) => void;
  resumeRehydratedPlayback: () => Promise<void>;
  playParagraph: (paragraphIndex: number, options?: { explicit?: boolean }) => Promise<void>;
  prefetchNextParagraph: (paragraphIndex: number) => Promise<void>;
  handleParagraphEnded: () => Promise<boolean>;
  handleExplicitPause: () => void;
  /** §30 restart：新 sessionId + position 0（保留 completedAt 由 server 侧持有）。 */
  restart: () => Promise<void>;
  promoteDraftToWork: (workId: number, deps?: SessionRehydrateDeps) => Promise<void>;
  beginPlayback: (params: {
    source: PlaybackSourceRef;
    mode: 'resume' | 'restart';
    speed?: number;
    draftSnapshot?: { title: string; contentHash: string; totalParagraphs: number; voiceId: string };
  }) => Promise<void>;
  /**
   * M7-03 当前 Session Sleep Timer 设置（spec §24，经 playback.setSleepTimer）。
   * 只改当前 Session Timer，不自动改 Settings 默认（§31.1）。
   * 成功后同步 Session.sleepTimerMode + Transport 三态/预算，并收敛 checkpoint；
   * stale（Session 已切换）时返回 false，不覆盖新 Session timer（§24.1）。
   */
  setSleepTimer: (mode: SleepTimerMode, minutes?: number) => Promise<boolean>;
  /**
   * M7-03 Sleep Timer 到期承接（spec §26，由 Transport 到期回调经 flow 触发）。
   * Transport 已 pause audio + 归一 off/null；此处置 Session paused + 持久化
   * checkpoint（显式携带 off/null）+ Toast。之后 Play 正常继续。
   */
  handleSleepTimerExpired: () => Promise<void>;
  /** 取消尚未发射的 debounce checkpoint（setSleepTimer 前调用，防旧预算覆盖新 Timer）。 */
  cancelDeferredCheckpoint: () => void;
  saveCheckpointDebounced: (options?: { forceReset?: boolean }) => void;
  saveCheckpointImmediate: (options?: { forceReset?: boolean }) => Promise<void>;
  clearSession: () => Promise<void>;
  stop: () => void;
  reset: () => void;
  setStatus: (status: PlaybackSessionStatus) => void;
}

export type PlaybackSessionStore = PlaybackSessionState & PlaybackSessionActions;

/** 可注入的 rehydrate 依赖（生产默认走真实 client/store；测试注入 fake）。 */
export interface SessionRehydrateDeps {
  getAnchor?: () => Promise<GetPlaybackAnchorOutput>;
  getWork?: (workId: number) => Promise<{
    title: string;
    storyText: string;
    voiceId: string;
    contentHash: string;
  }>;
  ensureChatLoaded?: () => Promise<void>;
  /**
   * M8-04 Work Manifest 只读投影（spec §23 Segmentation SSOT）。
   * 生产默认经 storyAudio.getPlaybackManifest；测试可注入 fake；
   * 正常返回 missing/segments=[] 表示真无 Manifest（回落本地切分合法）；
   * fetch throws 表示 unknown（M8-04 FIXUP Blocking 2：canonical Work fail-closed，
   * 不得回落本地，不得进 ready，可 retry，不得删 Session/清 Anchor）。
   */
  getManifest?: (workId: number) => Promise<{
    segments: Array<{ index: number; text: string }>;
    segmentationVersion?: string;
    segmentCount?: number;
  } | null>;
  /**
   * M5-09 fixup canonical：Draft 快照解析（Modern first → Legacy fallback）。
   * 生产默认经 resolvePlaybackDraftSnapshot；测试可注入 fake snapshot。
   */
  findDraftSnapshot?: (messageId: string) => PlaybackDraftSnapshot | null;
  /**
   * @deprecated 仅为旧测试注入兼容保留（string 形态绕过 canonical 快照）。
   * 新代码一律用 findDraftSnapshot；hydrate 优先 snapshot，其次才看本字段。
   */
  findDraftStoryText?: (messageId: string) => string | null;
  clearAnchor?: (sessionId: string) => Promise<unknown>;
  notifyDrift?: () => void;
}

const INITIAL_SESSION_STATE: PlaybackSessionState = {
  sessionId: null,
  source: null,
  title: '',
  storyText: '',
  paragraphs: [],
  contentHash: '',
  segmentationVersion: SEGMENTATION_VERSION,
  lastCompletedParagraphIndex: -1,
  nextParagraphIndex: 0,
  totalParagraphs: 1,
  voiceId: '',
  speed: 1.0,
  continuationMode: 'finite',
  status: 'idle',
  sleepTimerMode: 'off',
  prefetchedAudioUrl: null,
  prefetchingIndex: null,
  lastSavedKey: null,
  hydrationEpoch: 0,
};

let debounceSaveTimer: ReturnType<typeof setTimeout> | null = null;
let prefetchAbortController: AbortController | null = null;
let initPromise: Promise<boolean> | null = null;
let hydrationEpochCounter = 0;

const clearDebounceTimer = () => {
  if (debounceSaveTimer) {
    clearTimeout(debounceSaveTimer);
    debounceSaveTimer = null;
  }
};

const abortPrefetch = () => {
  if (prefetchAbortController) {
    prefetchAbortController.abort();
    prefetchAbortController = null;
  }
};

/**
 * M8-04 canonical ensure 重试上限（spec §15.3 retryAfter 500ms 轮询）。
 * Lease TTL 60s，TTS 通常数秒；上限 20 次（约 10s）后按失败抛错，
 * 由 play/prefetch 按 error/静默路径处理，不无限等待。
 */
const CANONICAL_ENSURE_MAX_ATTEMPTS = 20;

/** 仅 blob: 才 revoke（canonical segment 与 T3 单轨 /api/audio/assets/* 永不 revoke）。 */
function revokeAudioUrlIfBlob(url: string | null): void {
  if (typeof url !== 'string' || url.length === 0) return;
  if (isCanonicalPlaybackUrl(url)) return;
  if (isSingleTrackPlaybackUrl(url)) return;
  if (!url.startsWith('blob:')) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // 忽略回收失败。
  }
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * M8-04 Work Segment canonical 获取（含 preparing 轮询，不动 M5 stale 语义）。
 *
 * - ready → 返回 playbackUrl（/api/audio/segments/<id>，永不 revoke）；
 * - preparing → 按 retryAfterMs 等待后重试（上限内），abort/stale 由调用方判定；
 * - 抛错 → 由调用方按 error/静默路径处理（play 置 error+Toast，prefetch 静默）。
 */
async function fetchCanonicalAudioUrlWithRetry(
  workId: number,
  segmentIndex: number,
  sessionId: string,
  options?: { signal?: AbortSignal },
): Promise<string> {
  // T3：单轨开关开启时整篇只物化一个 Asset，任意段落索引都返回同一 URL。
  if (isSingleTrackAudioEnabled()) {
    let singleAttempts = 0;
    for (;;) {
      singleAttempts += 1;
      const output = await ensureCanonicalAsset({ workId, sessionId });
      if (output.status === 'ready') return output.asset.playbackUrl;
      if (singleAttempts >= CANONICAL_ENSURE_MAX_ATTEMPTS) {
        throw new Error('canonical single-track preparing timeout');
      }
      if (options?.signal?.aborted) throw new Error('canonical prefetch aborted');
      const retryAfter =
        typeof output.retryAfterMs === 'number' ? output.retryAfterMs : 500;
      await sleepMs(Math.max(0, Math.min(retryAfter, 2000)), options?.signal);
      if (options?.signal?.aborted) throw new Error('canonical prefetch aborted');
    }
  }
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const output = await ensureCanonicalSegment({ workId, segmentIndex, sessionId });
    if (output.status === 'ready') {
      return output.segment.playbackUrl;
    }
    if (attempts >= CANONICAL_ENSURE_MAX_ATTEMPTS) {
      throw new Error('canonical segment preparing timeout');
    }
    if (options?.signal?.aborted) {
      throw new Error('canonical prefetch aborted');
    }
    const retryAfter =
      typeof (output as { retryAfterMs?: unknown }).retryAfterMs === 'number'
        ? ((output as { retryAfterMs: number }).retryAfterMs as number)
        : 500;
    await sleepMs(Math.max(0, Math.min(retryAfter, 2000)), options?.signal);
    if (options?.signal?.aborted) {
      throw new Error('canonical prefetch aborted');
    }
  }
}

/**
 * M5-09 fixup：Draft 快照默认解析——只消费 canonical resolver，不再理解 wire 结构。
 * Modern-first 优先级与 Legacy 只读 fallback 均收敛在 Chat domain 层。
 */
function defaultFindDraftSnapshot(messageId: string): PlaybackDraftSnapshot | null {
  return resolvePlaybackDraftSnapshot(messageId);
}

/** @deprecated 兼容垫片：经 canonical snapshot 派生 string（保留旧注入形态）。 */
function defaultFindDraftStoryText(messageId: string): string | null {
  return resolvePlaybackDraftSnapshot(messageId)?.storyText ?? null;
}

const defaultDeps: Required<SessionRehydrateDeps> = {
  getAnchor: () => getPlaybackAnchor(),
  getWork: async (workId: number) => {
    const detail = await getWorkDetail({ id: workId });
    return {
      title: detail.title,
      storyText: detail.storyText,
      voiceId: detail.voiceId,
      contentHash: detail.contentHash,
    };
  },
  ensureChatLoaded: async () => {
    await useChatStore.getState().initForUser();
  },
  getManifest: async (workId: number) => {
    // M8-04 FIXUP Blocking 2：fetch throws 与 missing 必须区分。
    // missing（null/segments=[]）由 hydrate 回落本地；throws 直接抛由 hydrate fail-closed。
    const manifest = await fetchPlaybackManifest({ workId });
    if (!manifest) return null;
    return {
      segments: manifest.segments,
      segmentationVersion: manifest.segmentationVersion,
      segmentCount: manifest.segmentCount,
    };
  },
  findDraftSnapshot: (messageId: string) => defaultFindDraftSnapshot(messageId),
  findDraftStoryText: (messageId: string) => defaultFindDraftStoryText(messageId),
  clearAnchor: (sessionId: string) => clearPlaybackAnchor({ sessionId }),
  notifyDrift: () => {
    GlassToast.show({ icon: 'fail', content: '故事正文已更新，将从开头重新播放' });
  },
};

function resolveDeps(deps?: SessionRehydrateDeps): Required<SessionRehydrateDeps> {
  return {
    getAnchor: deps?.getAnchor ?? defaultDeps.getAnchor,
    getWork: deps?.getWork ?? defaultDeps.getWork,
    ensureChatLoaded: deps?.ensureChatLoaded ?? defaultDeps.ensureChatLoaded,
    getManifest: deps?.getManifest ?? defaultDeps.getManifest,
    findDraftSnapshot: deps?.findDraftSnapshot ?? defaultDeps.findDraftSnapshot,
    findDraftStoryText: deps?.findDraftStoryText ?? defaultDeps.findDraftStoryText,
    clearAnchor: deps?.clearAnchor ?? defaultDeps.clearAnchor,
    notifyDrift: deps?.notifyDrift ?? defaultDeps.notifyDrift,
  };
}

/**
 * Draft 快照 canonical 消费（M5-09 fixup）：
 * 显式注入 findDraftSnapshot 优先；仅注入旧 string 时做一次性适配；
 * 两者皆无注入时走默认 canonical resolver。Store 不再理解 wire 结构。
 */
function resolveDraftSnapshotForHydrate(
  messageId: string,
  deps: SessionRehydrateDeps | undefined,
  resolved: Required<SessionRehydrateDeps>,
): PlaybackDraftSnapshot | null {
  if (deps?.findDraftSnapshot) {
    return deps.findDraftSnapshot(messageId);
  }
  if (deps?.findDraftStoryText) {
    const text = deps.findDraftStoryText(messageId);
    return typeof text === 'string' && text.length > 0 ? { storyText: text } : null;
  }
  return resolved.findDraftSnapshot(messageId);
}

/** dangling 清理（fail-closed）：本地 + transport 复位，best-effort 清 server Anchor。 */
async function dropDanglingAnchor(
  get: () => PlaybackSessionStore,
  set: (partial: Partial<PlaybackSessionState>) => void,
  sessionId: string | null,
  clearAnchorFn: (sessionId: string) => Promise<unknown>,
  reason: string,
): Promise<boolean> {
  console.warn(`[playbackSessionStore] Resolved source missing; dropped dangling anchor (${reason})`);
  if (sessionId) {
    try {
      await clearAnchorFn(sessionId);
    } catch {
      // best-effort：server 清理失败不掩盖 fail-closed，仍复位本地。
    }
  }
  get().reset();
  try {
    usePlaybackStore.getState().reset();
  } catch {
    // transport 复位失败仅告警，不抛错阻断水合返回。
  }
  return false;
}

const playbackSessionStoreCreator: StateCreator<PlaybackSessionStore> = (set, get) => ({
  ...INITIAL_SESSION_STATE,

  setStatus: (status) => set({ status }),

  init: async (deps) => {
    if (initPromise) return initPromise;
    const d = resolveDeps(deps);
    hydrationEpochCounter += 1;
    const epoch = hydrationEpochCounter;
    set({ hydrationEpoch: epoch, status: 'hydrating' });
    initPromise = (async (): Promise<boolean> => {
      try {
        const anchor = await d.getAnchor();
        // 纪元守卫：init 并发/切账号后过期 resolve 直接丢弃。
        if (get().hydrationEpoch !== epoch) return false;
        if (!anchor) {
          if (get().hydrationEpoch === epoch) set({ status: 'idle' });
          return false;
        }
        return get().hydrateFromAnchor(anchor, deps);
      } catch (err) {
        console.warn('[playbackSessionStore] init failed', err);
        if (get().hydrationEpoch === epoch) set({ status: 'idle' });
        return false;
      } finally {
        initPromise = null;
      }
    })();
    return initPromise;
  },

  initForUser: async (deps) => get().init(deps),

  initForGuest: async (deps) => get().init(deps),

  hydrateFromAnchor: async (anchor, deps) => {
    const d = resolveDeps(deps);
    const epochAtStart = get().hydrationEpoch;
    set({ status: 'hydrating' });

    // —— §25 resolve Source（Work 精确 resolve / Draft 查卡） ——
    let storyText = '';
    let liveTitle: string | null = null;
    let liveVoiceId = anchor.voiceId;

    if (anchor.source.kind === 'draft') {
      try {
        await d.ensureChatLoaded();
      } catch (err) {
        console.warn('[playbackSessionStore] draft chat load failed', err);
      }
      if (get().hydrationEpoch !== epochAtStart) return false;
      // M5-09 fixup：只消费 canonical resolver 输出（snapshot），不解析 wire。
      const snapshot = resolveDraftSnapshotForHydrate(anchor.source.messageId, deps, d);
      if (!snapshot || typeof snapshot.storyText !== 'string' || snapshot.storyText.length === 0) {
        return dropDanglingAnchor(
          get,
          set,
          anchor.sessionId ?? null,
          d.clearAnchor,
          `draft:${anchor.source.messageId}`,
        );
      }
      storyText = snapshot.storyText;
      liveTitle =
        typeof snapshot.title === 'string' && snapshot.title.length > 0 ? snapshot.title : null;
      if (!liveVoiceId && typeof snapshot.voiceId === 'string' && snapshot.voiceId.length > 0) {
        liveVoiceId = snapshot.voiceId;
      }
    } else {
      // §25.1：严禁走 generationHistoryStore 最近 N 条 find(id)；
      // library.get(workId) 精确 resolve（分页后 Anchor 可指向任意页）。
      let work: { title: string; storyText: string; voiceId: string; contentHash: string };
      try {
        work = await d.getWork(anchor.source.workId);
      } catch {
        return dropDanglingAnchor(
          get,
          set,
          anchor.sessionId ?? null,
          d.clearAnchor,
          `work:${anchor.source.workId}`,
        );
      }
      if (get().hydrationEpoch !== epochAtStart) return false;
      if (!work || typeof work.storyText !== 'string' || work.storyText.length === 0) {
        return dropDanglingAnchor(
          get,
          set,
          anchor.sessionId ?? null,
          d.clearAnchor,
          `work:${anchor.source.workId}`,
        );
      }
      storyText = work.storyText;
      liveTitle = work.title;
      if (!liveVoiceId && work.voiceId) liveVoiceId = work.voiceId;
    }

    // —— §25.3 Hash Validation（统一 segmentation SSOT） ——
    const normalized = normalizeStoryText(storyText);
    const currentHash = computeStoryContentHash(normalized);
    const localParagraphs = segmentStoryText(normalized);
    // M8-04 Segmentation SSOT（spec §23）+ FIXUP/FIXUP-2 Blocking：
    // Work hydrate 始终读取 Manifest identity（与 CANONICAL_AUDIO flag 无关）：
    // Manifest 已存在 → Work 播放段落文本 SSOT = Manifest.segments[].text，
    // effectiveSegmentationVersion = manifest.segmentationVersion，
    // effectiveTotalParagraphs = manifest.segmentCount（Manifest 权威）；
    // 无 Manifest（null/segments=[]）→ 回落本地切分，第一次真正请求时 ensure 侧 lazy 建；
    // Manifest 读取 throws（unknown）→ Work fail-closed：不进 ready，
    // 不把 local 当 SSOT，不改写 version，不推进/重置 Progress，可 retry，
    // 不删 Session、不清 Anchor。flag 只控制音源 provider（play/prefetch：
    // on→ensureSegment/canonical URL，off→fetchAudio/ephemeral），不控制 identity。
    // Draft 恒本地切分（不受开关影响）。
    let paragraphs = localParagraphs;
    let effectiveSegmentationVersion = SEGMENTATION_VERSION;
    let effectiveTotalParagraphs = Math.max(1, localParagraphs.length);
    if (anchor.source.kind === 'work') {
      let manifest: {
        segments: Array<{ index: number; text: string }>;
        segmentationVersion?: string;
        segmentCount?: number;
      } | null;
      try {
        manifest = await d.getManifest(anchor.source.workId);
      } catch (err) {
        // FIXUP Blocking 2 / FIXUP-2：unknown ≠ missing，不得回落本地（flag 无关）。
        console.warn('[playbackSessionStore] manifest read failed, fail-closed', err);
        if (get().hydrationEpoch !== epochAtStart) return false;
        set({ status: 'error' });
        return false;
      }
      if (get().hydrationEpoch !== epochAtStart) return false;
      if (manifest && Array.isArray(manifest.segments) && manifest.segments.length > 0) {
        paragraphs = selectWorkParagraphs(localParagraphs, manifest);
        if (
          typeof manifest.segmentationVersion === 'string' &&
          manifest.segmentationVersion.length > 0
        ) {
          effectiveSegmentationVersion = manifest.segmentationVersion;
        }
        if (
          typeof manifest.segmentCount === 'number' &&
          Number.isFinite(manifest.segmentCount) &&
          Math.floor(manifest.segmentCount) >= 1
        ) {
          effectiveTotalParagraphs = Math.floor(manifest.segmentCount);
        } else {
          effectiveTotalParagraphs = Math.max(1, paragraphs.length);
        }
      } else {
        effectiveTotalParagraphs = Math.max(1, paragraphs.length);
      }
    } else {
      effectiveTotalParagraphs = Math.max(1, paragraphs.length);
    }
    const totalParagraphs = effectiveTotalParagraphs;
    const position = decideRehydratedPosition({
      savedNextParagraphIndex: anchor.nextParagraphIndex,
      savedLastCompletedParagraphIndex: anchor.lastCompletedParagraphIndex,
      savedContentHash: anchor.contentHash,
      savedSegmentationVersion: anchor.segmentationVersion,
      currentContentHash: currentHash,
      currentSegmentationVersion: effectiveSegmentationVersion,
      totalParagraphs,
    });
    if (position.drifted) {
      try {
        d.notifyDrift();
      } catch {
        // toast 失败不阻断水合。
      }
    }

    // —— §25.4 Title 变化：更新 title，不重置 progress ——
    const title = resolveRehydratedTitle(anchor.title, liveTitle);

    if (get().hydrationEpoch !== epochAtStart) return false;

    // —— §25.5 最终状态：status=ready + transport idle，不 autoplay ——
    set({
      sessionId: anchor.sessionId,
      source: anchor.source.kind === 'draft'
        ? { kind: 'draft', messageId: anchor.source.messageId }
        : { kind: 'work', workId: anchor.source.workId },
      title,
      storyText: normalized,
      paragraphs,
      contentHash: currentHash,
      segmentationVersion: effectiveSegmentationVersion,
      lastCompletedParagraphIndex: position.lastCompletedParagraphIndex,
      nextParagraphIndex: position.nextParagraphIndex,
      totalParagraphs,
      voiceId: liveVoiceId,
      speed: anchor.speed,
      continuationMode: rehydratedContinuationMode(),
      status: 'ready',
      // M7-03：Anchor.sleepTimerMode 运行时镜像（off/minutes/story_end，§22/§23）。
      sleepTimerMode: anchor.sleepTimerMode,
      lastSavedKey: `${anchor.sessionId}:${position.nextParagraphIndex}`,
    });

    try {
      usePlaybackStore.getState().hydrateFromProgress({
        sessionId: anchor.sessionId,
        currentMessageId: anchor.source.kind === 'draft' ? anchor.source.messageId : null,
        sourceType: anchor.source.kind === 'draft' ? 'draft' : 'work',
        sourceId: anchor.source.kind === 'draft'
          ? anchor.source.messageId
          : String(anchor.source.workId),
        title,
        remainingMs: anchor.remainingAllowedMs ?? null,
        totalAllowedMs: anchor.totalAllowedMs ?? null,
        // M7-03：Transport 三态与预算同源同步（countdown 门，§25）。
        sleepTimerMode: anchor.sleepTimerMode,
        isOneShot: true,
        currentParagraphIndex: position.nextParagraphIndex,
        totalParagraphs,
      });
    } catch (err) {
      console.warn('[playbackSessionStore] transport sync failed', err);
    }

    // M7-02 P3A：rehydrate 即时同步 Transport.playbackRate = Anchor.speed
    //（无 isRehydratedReady 特殊分支，spec §61；只经 Transport，不碰 UserConfig）。
    try {
      const anchorSpeed = anchor.speed;
      if (typeof anchorSpeed === 'number' && Number.isFinite(anchorSpeed)) {
        usePlaybackStore.getState().setPlaybackRate(anchorSpeed);
      }
    } catch {
      // rate 同步失败不阻断水合（transport 保持既有值）。
    }

    return true;
  },

  setSpeed: async (rate) => {
    const state = get();
    if (!state.source || !state.sessionId) return;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0.25 || rate > 4.0) {
      return;
    }
    if (state.speed === rate) {
      // 仍需保证 Transport 一致（rehydrate 错位修复），但不重复落盘。
      try {
        if (usePlaybackStore.getState().playbackRate !== rate) {
          usePlaybackStore.getState().setPlaybackRate(rate);
        }
      } catch {
        // ignore
      }
      return;
    }
    set({ speed: rate });
    try {
      usePlaybackStore.getState().setPlaybackRate(rate);
    } catch {
      // transport 同步失败不阻断 session 侧（下次读取仍以 Session.speed 为准）。
    }
    // Anchor 持久化（同一 Session 内 speed 上报；stale 时 server 侧 no-op，不抛错）。
    await get().saveCheckpointImmediate({ forceReset: false });
  },

  setActiveStory: (params) => {
    if (params.source.kind === 'draft' && params.source.messageId.startsWith('replay-text-')) {
      return;
    }
    const normalized = normalizeStoryText(params.storyText);
    const currentHash = computeStoryContentHash(normalized);
    const paragraphs = segmentStoryText(normalized);
    const totalParagraphs = Math.max(1, paragraphs.length);
    const nextParagraphIndex = params.initialNextIndex ?? 0;
    const lastCompleted = nextParagraphIndex > 0 ? nextParagraphIndex - 1 : -1;

    abortPrefetch();
    clearDebounceTimer();

    // M7-03 新 Session Timer（§28）：不继承旧 Session remaining；显式传入优先，
    // 缺省按 User Config 默认解析（enabled→minutes，否则 off）。
    // 兼容旧形态：仅传 remaining（无 mode）视为 minutes（Legacy 规则 §23.1）。
    const explicitMode =
      params.sleepTimerMode ??
      (params.remainingAllowedMs != null ? ('minutes' as const) : undefined);
    const sessionTimer =
      explicitMode !== undefined
        ? {
            mode: explicitMode,
            remainingMs: explicitMode === 'minutes' ? (params.remainingAllowedMs ?? null) : null,
            totalMs: explicitMode === 'minutes' ? (params.totalAllowedMs ?? null) : null,
          }
        : resolveDefaultSessionTimer({
            defaultEnabled: (() => {
              try {
                return useConfigStore.getState().apiConfig.defaultSleepTimerEnabled !== false;
              } catch {
                return true;
              }
            })(),
            defaultMinutes: (() => {
              try {
                const cfg = useConfigStore.getState().apiConfig;
                return cfg.defaultSleepTimerMinutes > 0
                  ? cfg.defaultSleepTimerMinutes
                  : cfg.playDuration;
              } catch {
                return 30;
              }
            })(),
          });

    set({
      sessionId: params.sessionId ?? null,
      source: params.source.kind === 'draft'
        ? { kind: 'draft', messageId: params.source.messageId }
        : { kind: 'work', workId: params.source.workId },
      title: params.title,
      storyText: normalized,
      paragraphs,
      contentHash: currentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: lastCompleted,
      nextParagraphIndex,
      totalParagraphs,
      voiceId: params.voiceId ?? '',
      speed: params.speed ?? 1.0,
      continuationMode: params.continuationMode ?? 'finite',
      status: 'playing',
      sleepTimerMode: sessionTimer.mode,
      prefetchedAudioUrl: null,
      prefetchingIndex: null,
    });

    // M7-03：新会话 Transport Timer 同步（countdown 门与预算同源）。
    try {
      usePlaybackStore.getState().setSleepTimerState(
        sessionTimer.mode,
        sessionTimer.remainingMs,
        sessionTimer.totalMs,
      );
    } catch {
      // transport 同步失败不阻断本地激活。
    }

    try {
      usePlaybackStore.getState().setParagraphInfo({
        currentParagraphIndex: nextParagraphIndex,
        totalParagraphs,
        title: params.title,
      });
    } catch {
      // transport 同步失败不阻断本地激活。
    }

    // M7-02 P3A：新会话激活即时同步 Transport.playbackRate（只经 Transport，不碰 UserConfig）。
    try {
      const activeSpeed = params.speed ?? 1.0;
      if (typeof activeSpeed === 'number' && Number.isFinite(activeSpeed)) {
        usePlaybackStore.getState().setPlaybackRate(activeSpeed);
      }
    } catch {
      // ignore
    }
  },

  resumeRehydratedPlayback: async () => {
    const state = get();
    if (!state.source || state.paragraphs.length === 0) return;
    await usePlaybackStore.getState().ensureUnlocked();
    const playbackState = usePlaybackStore.getState();
    // M7-03：回落预算只在 minutes 模式补齐（off/story_end 的 null 合法，不得复活 Timer；
    // ensureCountdownBudget 内部亦有同门，此处只做新语义字段读取）。
    if (
      state.sleepTimerMode === 'minutes' &&
      (playbackState.remainingMs === null || playbackState.totalAllowedMs === null)
    ) {
      const cfg = useConfigStore.getState().apiConfig;
      const fallbackMinutes =
        cfg.defaultSleepTimerMinutes > 0 ? cfg.defaultSleepTimerMinutes : cfg.playDuration;
      if (
        typeof fallbackMinutes === 'number' &&
        Number.isFinite(fallbackMinutes) &&
        fallbackMinutes > 0
      ) {
        const fallbackBudgetMs = fallbackMinutes * 60000;
        playbackState.ensureCountdownBudget(fallbackBudgetMs);
      }
    }
    // M7-03：耗尽早退只适用于 minutes 模式（off/story_end 到期归一 null 后正常继续，§26）。
    if (state.sleepTimerMode === 'minutes') {
      const resumeBudgetMs = usePlaybackStore.getState().remainingMs;
      if (resumeBudgetMs !== null && resumeBudgetMs <= 0) return;
    }
    await get().playParagraph(get().nextParagraphIndex, { explicit: true });
  },

  playParagraph: async (paragraphIndex, options) => {
    const state = get();
    const originatingSessionId = state.sessionId;
    if (paragraphIndex >= state.paragraphs.length) {
      await get().clearSession();
      return;
    }
    const paragraphBudgetMs = usePlaybackStore.getState().remainingMs;
    // M7-03：耗尽守卫只适用于 minutes 模式（off/story_end null 合法，§26）。
    if (state.sleepTimerMode === 'minutes' && paragraphBudgetMs !== null && paragraphBudgetMs <= 0) {
      return;
    }
    if (
      !usePlaybackStore.getState().isPlaying &&
      usePlaybackStore.getState().currentAudioUrl !== null &&
      !options?.explicit
    ) {
      return;
    }

    const textToPlay = state.paragraphs[paragraphIndex];
    const voiceId = state.voiceId || useConfigStore.getState().apiConfig.voiceId;
    const speed = state.speed || useConfigStore.getState().apiConfig.speed;

    // M8-04 Work Segment audio provider 替换（只替换 provider，不动 M5 identity）：
    // Work + flag 开启 + 合法 sessionId → canonical（ensureSegment → ready playbackUrl）；
    // Draft / flag 关闭 / 非法 session → legacy ephemeral TTS。speed 永不进入 asset 身份。
    let useCanonical = false;
    let canonicalWorkId: number | null = null;
    let canonicalSessionId: string | null = null;
    try {
      if (
        state.source?.kind === 'work' &&
        (shouldUseCanonicalAudio(state.source) || isSingleTrackAudioEnabled()) &&
        typeof originatingSessionId === 'string' &&
        isValidPlaybackSessionId(originatingSessionId)
      ) {
        useCanonical = true;
        canonicalWorkId = state.source.workId;
        canonicalSessionId = originatingSessionId;
      }
    } catch {
      useCanonical = false;
    }

    let audioUrl = state.prefetchedAudioUrl;
    if (state.prefetchingIndex !== paragraphIndex || !audioUrl) {
      set({ status: 'synthesizing' });
      if (useCanonical && canonicalWorkId !== null && canonicalSessionId !== null) {
        try {
          audioUrl = await fetchCanonicalAudioUrlWithRetry(
            canonicalWorkId,
            paragraphIndex,
            canonicalSessionId,
          );
        } catch (err) {
          // §50 session guard：失败也须确认仍是同一 session 才置 error，避免旧结果覆盖新会话。
          if (get().sessionId !== originatingSessionId) return;
          set({ status: 'error' });
          GlassToast.show({ icon: 'fail', content: '语音生成稍有延迟，请重试' });
          throw err;
        }
      } else {
        try {
          audioUrl = await fetchAudio(textToPlay, voiceId, speed);
        } catch (err) {
          // §50 session guard：失败也须确认仍是同一 session 才置 error，避免旧 TTS 失败覆盖新会话。
          if (get().sessionId !== originatingSessionId) return;
          set({ status: 'error' });
          GlassToast.show({ icon: 'fail', content: '语音生成稍有延迟，请重试' });
          throw err;
        }
      }
    }

    // §50 session guard：async 结果晚到必须检查 sessionId，不一致直接丢弃，绝不覆盖新会话。
    // M8-04 stale：A ensure 慢、切到 B 后 A 资产可完成保留，但回客户端时 session 失配 → 绝不播放 A。
    if (get().sessionId !== originatingSessionId) {
      revokeAudioUrlIfBlob(audioUrl);
      return;
    }

    if (
      !usePlaybackStore.getState().isPlaying &&
      usePlaybackStore.getState().currentAudioUrl !== null &&
      !options?.explicit
    ) {
      return;
    }

    set({
      prefetchedAudioUrl: null,
      prefetchingIndex: null,
      nextParagraphIndex: paragraphIndex,
      status: 'playing',
    });

    usePlaybackStore.getState().clearRehydratedReady();
    usePlaybackStore.getState().setParagraphInfo({
      currentParagraphIndex: paragraphIndex,
      totalParagraphs: state.totalParagraphs,
    });

    const msgId = state.source?.kind === 'draft' ? state.source.messageId : undefined;
    await usePlaybackStore.getState().playAudio(audioUrl, msgId, { explicit: options?.explicit });
  },

  prefetchNextParagraph: async (paragraphIndex) => {
    const state = get();
    // T3 单轨：整篇已是一个 Asset，无“下一段”可预取（同一 URL 已缓存）。
    if (isSingleTrackAudioEnabled()) return;
    if (paragraphIndex !== state.nextParagraphIndex + 1) return;
    if (paragraphIndex >= state.paragraphs.length) return;
    if (!usePlaybackStore.getState().isPlaying) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    const remainingMs = usePlaybackStore.getState().remainingMs;
    // M7-03：预取预算门只适用于 minutes 模式（off/story_end null 合法，§26）。
    if (state.sleepTimerMode === 'minutes' && remainingMs !== null && remainingMs <= 0) return;
    if (state.prefetchingIndex === paragraphIndex) return;

    abortPrefetch();
    const abortCtrl = new AbortController();
    prefetchAbortController = abortCtrl;
    const originatingSessionId = state.sessionId;

    set({ prefetchingIndex: paragraphIndex });
    const textToPrefetch = state.paragraphs[paragraphIndex];
    const voiceId = state.voiceId || useConfigStore.getState().apiConfig.voiceId;
    const speed = state.speed || useConfigStore.getState().apiConfig.speed;

    // M8-04 lookahead 仍=1（本函数仅被 next+1 调用，绝不首播全篇）：
    // Work + flag 开启 → ensure N+1；Draft/关闭 → legacy fetchAudio。
    let prefetchCanonical: { workId: number; sessionId: string } | null = null;
    try {
      if (
        state.source?.kind === 'work' &&
        (shouldUseCanonicalAudio(state.source) || isSingleTrackAudioEnabled()) &&
        typeof originatingSessionId === 'string' &&
        isValidPlaybackSessionId(originatingSessionId)
      ) {
        prefetchCanonical = { workId: state.source.workId, sessionId: originatingSessionId };
      }
    } catch {
      prefetchCanonical = null;
    }

    try {
      const audioUrl = prefetchCanonical
        ? await fetchCanonicalAudioUrlWithRetry(
            prefetchCanonical.workId,
            paragraphIndex,
            prefetchCanonical.sessionId,
            { signal: abortCtrl.signal },
          )
        : await fetchAudio(textToPrefetch, voiceId, speed);
      if (abortCtrl.signal.aborted) return;
      // session 已切换则丢弃预取结果，不污染新会话。
      if (get().sessionId !== originatingSessionId) {
        revokeAudioUrlIfBlob(audioUrl);
        return;
      }
      set({ prefetchedAudioUrl: audioUrl, prefetchingIndex: paragraphIndex });
    } catch {
      if (!abortCtrl.signal.aborted) set({ prefetchingIndex: null });
    } finally {
      if (prefetchAbortController === abortCtrl) prefetchAbortController = null;
    }
  },

  handleParagraphEnded: async (): Promise<boolean> => {
    const state = get();
    // T3 单轨：整篇是一条时间轴，audio ended 即整 Work 完播；绝不按段落推进导致整轨重放。
    if (isSingleTrackAudioEnabled()) {
      set({
        lastCompletedParagraphIndex: Math.max(0, state.totalParagraphs - 1),
        nextParagraphIndex: state.totalParagraphs,
        status: 'ended',
      });
      try {
        if (state.sessionId) await completePlaybackSession({ sessionId: state.sessionId });
      } catch (err) {
        console.warn('[playbackSessionStore] completeSession failed', err);
      }
      set({ sleepTimerMode: 'off' });
      try {
        usePlaybackStore.getState().setSleepTimerState('off', null, null);
      } catch {
        // transport 同步失败不阻断完播返回。
      }
      return false;
    }
    // M8-04 FIXUP-4 fail-closed（Manifest unknown → 绝不以 Draft 切分冒充 Work Manifest SSOT）：
    // status=error 时当前 Blob 可自然播完，到 ended 事件时停止：不推进 next、不 checkpoint、
    // 不 fetchAudio、不 ensureSegment、不清 Session；等 hydrate/retry 恢复可信 Manifest SSOT。
    if (state.status === 'error') return false;
    if (state.totalParagraphs <= 0 || state.paragraphs.length === 0) return false;
    const completed = state.nextParagraphIndex;
    const next = completed + 1;
    if (next < state.totalParagraphs) {
      set({ lastCompletedParagraphIndex: completed, nextParagraphIndex: next });
      await get().saveCheckpointImmediate({ forceReset: false });
      await get().playParagraph(next);
      return true;
    }
    set({ lastCompletedParagraphIndex: completed, nextParagraphIndex: next, status: 'ended' });
    try {
      if (state.sessionId) await completePlaybackSession({ sessionId: state.sessionId });
    } catch (err) {
      console.warn('[playbackSessionStore] completeSession failed', err);
    }
    // M7-03 §27：Work 完播（任意 timer 模式）Timer reset off；再次播放使用新默认配置
    //（server completeSession 已持久化 off/null；此处同步运行时镜像，不另发 checkpoint）。
    set({ sleepTimerMode: 'off' });
    try {
      usePlaybackStore.getState().setSleepTimerState('off', null, null);
    } catch {
      // transport 同步失败不阻断完播返回。
    }
    return false;
  },

  handleExplicitPause: () => {
    abortPrefetch();
    set({ status: 'paused' });
    get().saveCheckpointDebounced({ forceReset: false });
  },

  restart: async () => {
    const state = get();
    if (!state.source) return;
    // M7-02 P3A 从头播放（spec §38/§38.1；复审 Blocking 1 收口为 server-authoritative）：
    // restart 一律经 server beginSession mode=restart 建新会话（新 UUID + position 0；
    // Work 侧 completedAt 由 server 保留）。begin 失败时保持原 session 原样并向上抛错
    // （由调用方 Toast 呈现），绝不本地伪造 Session——无 server Anchor 的本地 UUID
    // 会造成 stale-write / 刷新回旧 Anchor。
    const speed = state.speed ?? 1.0;
    if (state.source.kind === 'work') {
      const workId = state.source.workId;
      await get().beginPlayback({
        source: { kind: 'work', workId },
        mode: 'restart',
        speed,
      });
      await get().playParagraph(0, { explicit: true });
      return;
    }
    const messageId = state.source.messageId;
    if (messageId.startsWith('replay-text-')) {
      // 瞬态 replay-text-* 被 server 明确拒绝持久化（§16.4），无 server 会话语义：
      // 保持既有本地重播行为（同一本地上下文从头播放 + finite），不发起 server begin。
      abortPrefetch();
      set({
        nextParagraphIndex: 0,
        lastCompletedParagraphIndex: -1,
        continuationMode: 'finite',
        prefetchedAudioUrl: null,
        prefetchingIndex: null,
      });
      await get().playParagraph(0, { explicit: true });
      return;
    }
    // Draft：同样走 server-authoritative restart（新 UUID，§16.4 draft begin 天然 position 0）；
    // snapshot 取当前已水合会话的 canonical metadata（重播当前已存在文本，§38.1），
    // 随后强制 finite：到结尾停止、不触发 AI continuation（续写必须走单独 CTA）。
    const draftSnapshot =
      state.title && state.contentHash && state.totalParagraphs >= 1
        ? {
            title: state.title.slice(0, 100),
            contentHash: state.contentHash,
            totalParagraphs: state.totalParagraphs,
            voiceId: (state.voiceId || '').slice(0, 64),
          }
        : undefined;
    await get().beginPlayback({
      source: { kind: 'draft', messageId },
      mode: 'restart',
      speed,
      draftSnapshot,
    });
    set({ continuationMode: 'finite' });
    await get().playParagraph(0, { explicit: true });
  },

  promoteDraftToWork: async (workId, deps) => {
    const state = get();
    if (!state.sessionId || !state.source || state.source.kind !== 'draft') return;
    const sessionId = state.sessionId;
    const draftHash = state.contentHash;
    const draftNext = state.nextParagraphIndex;
    const draftParagraphs = state.paragraphs;
    const anchor = await promoteDraftPlaybackToWork({ sessionId, workId });
    // M8-04 FIXUP-3 Blocking（spec §23 Session.paragraphs[index]==Manifest.segments[index].text）：
    // server promotion 已返回 Manifest 权威 Anchor（version=Manifest version、total=Manifest segmentCount）；
    // client 必须同步把 Session 后续 segment provider 切到目标 Work Manifest frozen segments：
    // Manifest exists → paragraphs=Manifest.segments[].text，version/count 取 Manifest 权威 pair
    //（与 server Anchor version/count 一致性校验，不一致记 warn 仍以 Manifest 为准）；
    // Manifest missing（null/segments=[]）→ 保留既有 M5 promotion 行为（paragraphs 沿用 Draft）；
    // Manifest read throws（unknown）→ fail-closed：不得偷偷把 Draft paragraphs 当 Work Manifest SSOT，
    // 须显式置 status error 并向上抛错（server Anchor 已切 Work，本地 source 亦切 Work 保持一致，
    // 但 paragraphs 不可信，须经 hydrate retry 恢复；当前 Blob 不打断）。
    // 复用 getPlaybackManifest + selectWorkParagraphs，不造新状态；当前 Blob 不 pause/stop/换 URL（§22.4）。
    // §50 session guard：manifest 晚到时确认仍是同一 session，否则丢弃覆盖。
    const d = resolveDeps(deps);
    let manifest: {
      segments: Array<{ index: number; text: string }>;
      segmentationVersion?: string;
      segmentCount?: number;
    } | null = null;
    let manifestUnknown = false;
    try {
      manifest = await d.getManifest(workId);
    } catch (err) {
      manifestUnknown = true;
      console.warn('[playbackSessionStore] promote manifest read failed, fail-closed', err);
    }
    if (get().sessionId !== sessionId) return;
    if (manifestUnknown) {
      // fail-closed：source 切 Work 与 server 对齐，但 paragraphs 不可信 → 置 error 并抛错，
      // 绝不以 Draft 切分冒充 Work Manifest SSOT；当前 Blob 不打断，仅清未播预取。
      const preservedOnError = shouldPreserveDraftBreakpointOnPromote(draftHash, anchor.contentHash);
      const nextOnError = preservedOnError
        ? resolvePromotedNextParagraphIndex(draftNext, draftHash, anchor.contentHash, anchor.totalParagraphs)
        : 0;
      set({
        source: { kind: 'work', workId },
        title: anchor.title,
        contentHash: anchor.contentHash,
        segmentationVersion: anchor.segmentationVersion,
        lastCompletedParagraphIndex: nextOnError > 0 ? nextOnError - 1 : -1,
        nextParagraphIndex: nextOnError,
        totalParagraphs: anchor.totalParagraphs,
        voiceId: anchor.voiceId,
        speed: anchor.speed,
        status: 'error',
      });
      try {
        const stalePrefetch = get().prefetchedAudioUrl;
        abortPrefetch();
        revokeAudioUrlIfBlob(stalePrefetch);
      } catch {
        // ignore
      }
      set({ prefetchedAudioUrl: null, prefetchingIndex: null });
      try {
        if (typeof anchor.speed === 'number' && Number.isFinite(anchor.speed)) {
          usePlaybackStore.getState().setPlaybackRate(anchor.speed);
        }
      } catch {
        // ignore
      }
      throw new Error('[playbackSessionStore] promote manifest unknown, fail-closed');
    }
    let paragraphs = draftParagraphs;
    let effectiveSegmentationVersion = anchor.segmentationVersion;
    let effectiveTotalParagraphs = anchor.totalParagraphs;
    if (manifest && Array.isArray(manifest.segments) && manifest.segments.length > 0) {
      paragraphs = selectWorkParagraphs(draftParagraphs, manifest);
      if (
        typeof manifest.segmentationVersion === 'string' &&
        manifest.segmentationVersion.length > 0
      ) {
        if (manifest.segmentationVersion !== anchor.segmentationVersion) {
          console.warn('[playbackSessionStore] promote manifest version mismatch anchor, use manifest', {
            manifest: manifest.segmentationVersion,
            anchor: anchor.segmentationVersion,
          });
        }
        effectiveSegmentationVersion = manifest.segmentationVersion;
      }
      if (
        typeof manifest.segmentCount === 'number' &&
        Number.isFinite(manifest.segmentCount) &&
        Math.floor(manifest.segmentCount) >= 1
      ) {
        if (Math.floor(manifest.segmentCount) !== anchor.totalParagraphs) {
          console.warn('[playbackSessionStore] promote manifest count mismatch anchor, use manifest', {
            manifest: manifest.segmentCount,
            anchor: anchor.totalParagraphs,
          });
        }
        effectiveTotalParagraphs = Math.floor(manifest.segmentCount);
      } else {
        effectiveTotalParagraphs = Math.max(1, paragraphs.length);
      }
    } else {
      // Manifest missing → M5 行为：paragraphs 沿用 Draft，version/count 沿用 Anchor（无 Manifest 时 Anchor 即当前切分）。
    }
    // server 已切换 source/title/hash/voiceId（sessionId 不变）；本地按 hash 取舍断点（基于 Manifest 权威 total 钳制）。
    const preserved = shouldPreserveDraftBreakpointOnPromote(draftHash, anchor.contentHash);
    const next = preserved
      ? resolvePromotedNextParagraphIndex(draftNext, draftHash, anchor.contentHash, effectiveTotalParagraphs)
      : 0;
    set({
      source: { kind: 'work', workId },
      title: anchor.title,
      contentHash: anchor.contentHash,
      segmentationVersion: effectiveSegmentationVersion,
      lastCompletedParagraphIndex: next > 0 ? next - 1 : -1,
      nextParagraphIndex: next,
      totalParagraphs: effectiveTotalParagraphs,
      paragraphs,
      voiceId: anchor.voiceId,
      speed: anchor.speed,
    });
    // M8-04 Draft→Work promotion continuity（spec §22.4）：
    // 当前正在播放的 Draft Blob（transport currentAudioUrl）不打断、不换音源；
    // 仅丢弃尚未播放的 Draft 预取（prefetched），下一次需要后续/重播 Work Segment
    // 时才走 canonical path。transport 侧不做任何 stop/pause。
    try {
      const stalePrefetch = get().prefetchedAudioUrl;
      abortPrefetch();
      revokeAudioUrlIfBlob(stalePrefetch);
    } catch {
      // ignore
    }
    set({ prefetchedAudioUrl: null, prefetchingIndex: null });
    // 提升后 rate 同步 Transport（与 hydrate/setActive 同口径，不碰 UserConfig）。
    try {
      if (typeof anchor.speed === 'number' && Number.isFinite(anchor.speed)) {
        usePlaybackStore.getState().setPlaybackRate(anchor.speed);
      }
    } catch {
      // ignore
    }
  },

  beginPlayback: async (params) => {
    const sessionId = createPlaybackSessionId();
    const speed = params.speed ?? get().speed ?? 1.0;
    // M7-03 新 Session Timer（§28/§62）：不继承旧 Session remaining，一律按 User Config
    // 默认重新计算（enabled→minutes，否则 off）；server 显式持久化 mode。
    const defaultTimer = resolveDefaultSessionTimer({
      defaultEnabled: (() => {
        try {
          return useConfigStore.getState().apiConfig.defaultSleepTimerEnabled !== false;
        } catch {
          return true;
        }
      })(),
      defaultMinutes: (() => {
        try {
          const cfg = useConfigStore.getState().apiConfig;
          return cfg.defaultSleepTimerMinutes > 0 ? cfg.defaultSleepTimerMinutes : cfg.playDuration;
        } catch {
          return 30;
        }
      })(),
    });
    const anchor = await beginPlaybackSession({
      sessionId,
      source: params.source,
      mode: params.mode,
      speed,
      remainingAllowedMs: defaultTimer.remainingMs,
      totalAllowedMs: defaultTimer.totalMs,
      sleepTimerMode: defaultTimer.mode,
      draftSnapshot: params.draftSnapshot,
    });
    await get().hydrateFromAnchor(anchor);
  },

  setSleepTimer: async (mode, minutes) => {
    const state = get();
    if (!state.sessionId || !state.source) return false;
    // Draft story_end 本地先行门禁（server 亦拒绝；UI 侧不展示该选项，§22.1）。
    if (mode === 'story_end' && state.source.kind !== 'work') return false;
    if (mode === 'minutes' && !(typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 10 && minutes <= 120)) {
      return false;
    }
    // M7-02 复审约束：先取消尚未发射的 debounce checkpoint，防旧预算覆盖新 Timer。
    clearDebounceTimer();
    const sessionId = state.sessionId;
    let result: Awaited<ReturnType<typeof apiSetSleepTimer>>;
    try {
      result =
        mode === 'minutes'
          ? await apiSetSleepTimer({ sessionId, mode, minutes })
          : await apiSetSleepTimer({ sessionId, mode });
    } catch (err) {
      console.warn('[playbackSessionStore] setSleepTimer failed', err);
      return false;
    }
    if (!result.accepted) {
      // STALE_SESSION：Session 已切换，不覆盖新 Session timer（§24.1）。
      return false;
    }
    // §50 session guard：回包晚到时确认仍是同一 session，否则丢弃同步。
    if (get().sessionId !== sessionId) return false;
    const anchor = result.anchor;
    set({ sleepTimerMode: anchor.sleepTimerMode });
    try {
      usePlaybackStore.getState().setSleepTimerState(
        anchor.sleepTimerMode,
        anchor.remainingAllowedMs ?? null,
        anchor.totalAllowedMs ?? null,
      );
    } catch {
      // transport 同步失败不掩盖 server 成功（下次 checkpoint 收敛）。
    }
    // Timer 独立持久化已完成；追加一次 checkpoint 收敛段落/speed 同一 Anchor
    //（显式携带新 timer，dedupe key 覆盖 timer 语义，防吞变更）。
    await get().saveCheckpointImmediate({ forceReset: false });
    return true;
  },

  handleSleepTimerExpired: async () => {
    const state = get();
    if (!state.sessionId || !state.source) return;
    // Transport 已 pause audio + 归一 off/null；Session 置 paused（保留会话，§26）。
    abortPrefetch();
    set({ status: 'paused', sleepTimerMode: 'off', prefetchedAudioUrl: null, prefetchingIndex: null });
    // 持久化到期态（显式携带 off/null；forceReset 绕过 dedupe，确保真实落盘）。
    await get().saveCheckpointImmediate({ forceReset: true });
    try {
      GlassToast.show({ icon: 'success', content: '睡眠定时已结束', duration: 3000 });
    } catch {
      // toast 失败不阻断到期收尾。
    }
  },

  cancelDeferredCheckpoint: () => {
    clearDebounceTimer();
  },

  saveCheckpointDebounced: (options) => {
    clearDebounceTimer();
    debounceSaveTimer = setTimeout(() => {
      void get().saveCheckpointImmediate(options);
    }, 2000);
  },

  saveCheckpointImmediate: async (options) => {
    clearDebounceTimer();
    const state = get();
    if (!state.sessionId || !state.source) return;
    const playbackStore = usePlaybackStore.getState();
    // Blocking 2（M7-02 复审）：dedupe key 必须覆盖 speed——同 paragraph 内改倍速
    // 也必须真实落盘（否则 Session/Transport 已 1.5x 而 Anchor 仍旧值，刷新回退）。
    // M7-03（评审约束 8）：dedupe key 必须覆盖 timer 持久语义——mode/remaining/total
    // 任一变化都必须真实落盘（否则「Timer change 被 dedupe」：Session/Transport 已 off
    // 而 Anchor 仍 minutes，刷新复活旧 Timer）。
    const saveKey = `${state.sessionId}:${state.nextParagraphIndex}:${state.speed}:${state.sleepTimerMode}:${playbackStore.remainingMs ?? 'null'}:${playbackStore.totalAllowedMs ?? 'null'}:${options?.forceReset ? 'force' : 'normal'}`;
    if (!options?.forceReset && state.lastSavedKey === saveKey) return;
    try {
      await savePlaybackCheckpoint({
        sessionId: state.sessionId,
        contentHash: state.contentHash,
        segmentationVersion: state.segmentationVersion,
        lastCompletedParagraphIndex: state.lastCompletedParagraphIndex,
        nextParagraphIndex: state.nextParagraphIndex,
        totalParagraphs: state.totalParagraphs,
        speed: state.speed,
        remainingAllowedMs: playbackStore.remainingMs ?? undefined,
        totalAllowedMs: playbackStore.totalAllowedMs ?? undefined,
        sleepTimerMode: state.sleepTimerMode,
      });
      // 仅当 session 未切换才写 lastSavedKey，避免旧会话覆盖新键。
      if (get().sessionId === state.sessionId) set({ lastSavedKey: saveKey });
    } catch (err) {
      console.warn('[playbackSessionStore] saveCheckpoint failed', err);
    }
  },

  clearSession: async () => {
    clearDebounceTimer();
    abortPrefetch();
    const sessionId = get().sessionId;
    try {
      if (sessionId) await clearPlaybackAnchor({ sessionId });
    } catch (err) {
      console.warn('[playbackSessionStore] clearSession failed', err);
    }
    get().reset();
    try {
      usePlaybackStore.getState().reset();
    } catch {
      // ignore
    }
  },

  stop: () => {
    clearDebounceTimer();
    abortPrefetch();
    try {
      usePlaybackStore.getState().pauseAudioPlayback();
    } catch {
      // ignore
    }
    set({ status: 'paused', prefetchedAudioUrl: null, prefetchingIndex: null });
  },

  reset: () => {
    clearDebounceTimer();
    abortPrefetch();
    const epoch = get().hydrationEpoch;
    set({ ...INITIAL_SESSION_STATE, hydrationEpoch: epoch });
  },
});

export const usePlaybackSessionStore = create<PlaybackSessionStore>()(
  devtools(playbackSessionStoreCreator, { name: 'playback-session-store' }),
);

/** 测试隔离：清 debounce/prefetch/init 句柄与纪元（不触业务状态）。 */
export function __resetPlaybackSessionTestHooks(): void {
  clearDebounceTimer();
  abortPrefetch();
  initPromise = null;
  hydrationEpochCounter = 0;
}
