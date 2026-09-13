/**
 * M5-10 过渡态：本文件回到故事生成流程兼容层；播放 session / preload / ended
 * 编排已迁出至 app/services/playbackSessionFlow.ts + stores/playbackSessionStore.ts。
 * 下列 handleNearEnd / handleSegmentEnded / startStoryPlayback / replayGeneration /
 * playStoryText 保留为 legacy fallback（无 session 的旧音频链，M9 删除），
 * 新播放代码禁止新增调用，一律走 PlaybackSessionFlow。
 *
 * M5-10 收敛（§27/§28/§50）：
 * - continuation 唯一门在 PlaybackSessionFlow（continuationMode==='extendable'）；
 *   本文件首部的 session ownership 早退保证：只要 Session SSOT 持有 source 且
 *   finite，会话外的任何直接调用也不得触发 AI 续写；
 * - 旧 isOneShot / sourceId / currentMessageId guard 组合已退役为 legacy
 *   无 session 角落的传输锁（@deprecated），不再是续写决策依据；
 * - synthesizeAndPlayOnce 带 §50 stale TTS session 守卫：fetchAudio 晚到且
 *   session 已切换 → revoke blob / discard，绝不覆盖新会话播放。
 */
import { useConfigStore } from '@/stores/configStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { usePreloadStore } from '@/stores/preloadStore';
import { useChatStore } from '@/stores/chatStore';
import { useGenerationStore } from '@/stores/generationStore';
import { usePlaybackProgressStore } from '@/stores/playbackProgressStore';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import type { GenerationRecord } from '@/stores/generationHistoryStore';
import type { StoryCardPart } from '@/types/chat';
import { fetchAudio } from '@/lib/client/ttsGenerate';
import { computeStoryContentHash, normalizeStoryText } from '@/utils/segmentation';

/**
 * 可播放段落对象，包含音频地址与文本内容，并标注来源（首段/预加载/即时生成）。
 */
type PlayableSegment = {
  audioUrl: string;
  segment: string;
  messageId?: string;
};

/**
 * 预加载失败后的重试间隔（毫秒）。
 */
const PRELOAD_RETRY_DELAY = 5000;
/**
 * 预加载允许的最大重试次数。
 */
const PRELOAD_RETRY_LIMIT = 3;

/**
 * 预加载重试的挂起定时器实例。
 */
let preloadRetryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 清理预加载重试定时器，防止重复调度。
 */
const clearPreloadRetryTimer = () => {
  if (preloadRetryTimer) {
    clearTimeout(preloadRetryTimer);
    preloadRetryTimer = null;
  }
};

/**
 * 按固定间隔调度下一次预加载重试，超过上限后自动停止。
 */
const schedulePreloadRetry = () => {
  const { retryCount } = usePreloadStore.getState();
  if (retryCount >= PRELOAD_RETRY_LIMIT) {
    return;
  }
  if (preloadRetryTimer) {
    return;
  }

  preloadRetryTimer = setTimeout(async () => {
    preloadRetryTimer = null;
    try {
      await usePreloadStore.getState().requestPreload();
      clearPreloadRetryTimer();
    } catch {
      schedulePreloadRetry();
    }
  }, PRELOAD_RETRY_DELAY);
};

/**
 * 启动故事播放会话：停止当前播放、重置状态并开始播放指定的故事音频。
 * @param messageId 故事对应的消息 ID
 * @param audioUrl 音频地址
 * @param options.oneShot 一次性播放（历史回放）：播完即止，不触发预加载续写
 */
export const startStoryPlayback = async (
  messageId: string,
  audioUrl: string,
  options?: { oneShot?: boolean },
): Promise<void> => {
  const playbackStore = usePlaybackStore.getState();
  const preloadStore = usePreloadStore.getState();
  const apiConfig = useConfigStore.getState().apiConfig;

  // 停止当前正在播放的音频（如有）
  playbackStore.pauseAudioPlayback();

  // 重置状态
  preloadStore.reset();
  clearPreloadRetryTimer();
  playbackStore.reset();

  // 启动播放器会话
  playbackStore.markSessionStart(messageId, apiConfig.playDuration, options);

  // 若存在真实消息且处于 delivered 态，注册断点活跃故事
  if (!messageId.startsWith('replay-text-')) {
    const msg = useChatStore.getState().messages.find((m) => m.id === messageId);
    const storyCard = msg?.parts?.find((p): p is StoryCardPart => p.type === 'storyCard');
    if (msg && msg.status === 'delivered' && storyCard && storyCard.storyText) {
      usePlaybackProgressStore.getState().setActiveStory({
        sourceType: 'chat',
        sourceId: messageId,
        sessionId: messageId,
        title: '音频故事',
        storyText: storyCard.storyText,
        voiceId: apiConfig.voiceId,
        speed: apiConfig.speed,
        isOneShot: options?.oneShot ?? false,
        remainingAllowedMs: apiConfig.playDuration * 60000,
        totalAllowedMs: apiConfig.playDuration * 60000,
      });
    }
  }

  // 3. 自动开始播放生成的音频
  // 中文注释：H-07 自动链——此处经 reset() 已清空在播轨道（currentAudioUrl=null），窗口守卫天然放行，无需 explicit。
  await playbackStore.playAudio(audioUrl, messageId);
};

/**
 * Session ownership 早退（M5-10 §27/§28）：
 * Session SSOT 持有 source 且 finite 时，播放编排归 PlaybackSessionFlow 独占，
 * legacy 续写链不得以任何理由触发 AI continuation（也不得 reset 会话 transport）。
 * 仅无 session，或 extendable 尾段经 flow 显式委托，才允许继续 legacy 判定。
 * @returns true=调用方应直接返回（不得续写）
 */
const shouldYieldToPlaybackSession = (): boolean => {
  try {
    const session = usePlaybackSessionStore.getState();
    if (session.source && session.continuationMode !== 'extendable') {
      return true;
    }
  } catch {
    // session store 不可用时保持 legacy 行为（fail-open 仅限无 SSOT 角落）。
  }
  return false;
};

/**
 * 合成给定正文并一次性播放：播完即止（oneShot 防续写），不清空聊天会话。
 * 由于音频为临时 blob URL 无法持久化，历史/恢复回放均依赖正文重新走 TTS 合成。
 * @param storyText 故事正文。
 * @param voiceId 音色。
 * @param messageId 播放会话标识。
 */
const synthesizeAndPlayOnce = async (
  storyText: string,
  voiceId: string,
  messageId: string,
): Promise<void> => {
  // 清理可能残留的生成阶段，避免恢复态故事卡片误显示生成动效
  useGenerationStore.getState().reset();
  const { speed } = useConfigStore.getState().apiConfig;
  // §50 stale async TTS 守卫：记录合成发起时的 session，晚到先验 sessionId。
  const originatingSessionId = (() => {
    try {
      return usePlaybackSessionStore.getState().sessionId;
    } catch {
      return null;
    }
  })();
  const audioUrl = await fetchAudio(storyText, voiceId, speed);
  // session 已切换（NULL→有值/有值→他值/有值→清空，任何变化）→ 直接 revoke/discard，
  // 绝不 startStoryPlayback 覆盖新会话播放（与 session store playParagraph 同门）。
  try {
    if (usePlaybackSessionStore.getState().sessionId !== originatingSessionId) {
      try {
        if (audioUrl.startsWith('blob:')) URL.revokeObjectURL(audioUrl);
      } catch {
        // 忽略回收失败。
      }
      return;
    }
  } catch {
    // session store 不可用时保持 legacy 行为。
  }
  await startStoryPlayback(messageId, audioUrl, { oneShot: true });
};

/**
 * 回放一条历史生成（生成历史弹窗）。
 * @param record 生成历史记录。
 */
export const replayGeneration = async (record: GenerationRecord): Promise<void> => {
  const { voiceId, speed } = useConfigStore.getState().apiConfig;
  const chosenVoice = record.voiceId || voiceId;
  const sourceId = String(record.id);

  usePlaybackProgressStore.getState().setActiveStory({
    sourceType: 'generation',
    sourceId,
    title: record.prompt ? record.prompt.slice(0, 20) : '作品回放',
    storyText: record.storyText,
    voiceId: chosenVoice,
    speed,
    isOneShot: true,
  });

  await usePlaybackProgressStore.getState().playParagraph(0, { explicit: true });
};

/**
 * 回放给定故事正文（恢复态故事卡片的"播放故事"）。
 * @param storyText 故事正文。
 * @param messageId 可选：真实卡片 messageId
 */
export const playStoryText = async (storyText: string, messageId?: string): Promise<void> => {
  const { voiceId, speed } = useConfigStore.getState().apiConfig;
  const validId = messageId && !messageId.startsWith('replay-text-') ? messageId : '';

  if (validId) {
    // 断点恢复：若端侧已持有同一故事的真实断点（与按钮文案同源的 nextParagraphIndex），
    // 则直接从该断点续播；否则回落为从头播放。指纹比对可防止正文漂移时误用旧断点。
    const progressState = usePlaybackProgressStore.getState();
    const incomingHash = computeStoryContentHash(normalizeStoryText(storyText));
    const canResumeFromBreakpoint =
      progressState.sourceId === validId &&
      progressState.nextParagraphIndex > 0 &&
      progressState.paragraphs.length > 0 &&
      progressState.contentHash === incomingHash &&
      progressState.nextParagraphIndex < progressState.totalParagraphs;
    if (canResumeFromBreakpoint) {
      await progressState.resumeRehydratedPlayback();
      return;
    }
    usePlaybackProgressStore.getState().setActiveStory({
      sourceType: 'chat',
      sourceId: validId,
      sessionId: validId,
      title: '音频故事',
      storyText,
      voiceId,
      speed,
      isOneShot: true,
    });
    await usePlaybackProgressStore.getState().playParagraph(0, { explicit: true });
  } else {
    // 降级：未传稳定标识时一次性合成播放，不持久化悬挂断点
    await synthesizeAndPlayOnce(storyText, voiceId, `chat-${Date.now()}`);
  }
};

/**
 * 音频即将结束时触发预加载：若仍在有效播放时长内且未在加载，则请求下一段。
 *
 * @deprecated M5-10：续写决策已收敛至 PlaybackSessionFlow（§28 唯一门
 * continuationMode==='extendable'）。本函数仅为无 session legacy 音频的
 * 传输锁保留；首部 session ownership 早退保证 finite 会话永不进入旧判定。
 */
export const handleNearEnd = async (): Promise<void> => {
  // M5-10 §27/§28：Session SSOT 持有 finite 会话时直接让路（不触任何旧 guard）。
  if (shouldYieldToPlaybackSession()) {
    return;
  }
  const playbackState = usePlaybackStore.getState();
  if (!playbackState.sessionId) {
    return;
  }

  // 一次性播放（历史回放）不预加载续写
  // @deprecated M5-10：legacy 无 session 角落的传输锁；续写决策以 flow 的
  // continuationMode 唯一门为准，此处仅防无 session 旧音频误触续写。
  if (playbackState.isOneShot) {
    return;
  }

  // 中文注释：段落级故事（含恢复态/一次性回放）由段落预载推进，严禁走聊天续写分支。
  // 进度侧一次性标记与播放侧可能不同步，此处同时检查两者，避免最终段前误触“请继续故事”。
  // @deprecated M5-10：同上，legacy 角落传输锁（M9 随旧 store 删除）。
  const progressStateForNearEnd = usePlaybackProgressStore.getState();
  if (progressStateForNearEnd.isOneShot) {
    return;
  }
  if (progressStateForNearEnd.sourceId && progressStateForNearEnd.totalParagraphs > 0) {
    return;
  }

  if (playbackState.remainingMs !== null && playbackState.remainingMs <= 0) {
    return;
  }

  const preloadState = usePreloadStore.getState();
  if (preloadState.status === 'loading' || preloadState.status === 'ready') {
    return;
  }

  try {
    await usePreloadStore.getState().requestPreload();
    clearPreloadRetryTimer();
  } catch (error) {
    if (error instanceof Error && error.message === 'PRELOAD_IN_PROGRESS') {
      return;
    }
    schedulePreloadRetry();
  }
};

/**
 * 音频播放结束回调：优先消费已缓存的预加载内容，否则即时生成下一段。
 *
 * @deprecated M5-10：续写决策已收敛至 PlaybackSessionFlow（§28 唯一门）。
 * 本函数仅为无 session legacy 音频的兼容实现；首部 session ownership 早退
 * 保证 finite 会话永不进入旧 isOneShot/sourceId/currentMessageId 判定，
 * 且绝不 reset 会话 transport（bare return null，不碰任何 store）。
 * @returns 成功获取到的播放段落；若无需继续播放则返回 null
 */
export const handleSegmentEnded = async (): Promise<PlayableSegment | null> => {
  // M5-10 §27/§28：Session SSOT 持有 finite 会话时直接让路（bare null，不 reset）。
  if (shouldYieldToPlaybackSession()) {
    return null;
  }
  const playbackStore = usePlaybackStore.getState();
  const remainingMs = playbackStore.remainingMs ?? 0;

  // 一次性播放（历史回放）：播完即止，不续写下一段
  // 中文注释：段落路径（恢复卡/重合成）仅在进度侧持有一次性标记，播放侧可能未同步，故同时检查两者。
  // @deprecated M5-10：legacy 无 session 角落的传输锁；续写决策以 flow 的
  // continuationMode 唯一门为准（M9 随旧 store 删除）。
  const progressStateForOneShot = usePlaybackProgressStore.getState();
  if (playbackStore.isOneShot || progressStateForOneShot.isOneShot) {
    playbackStore.reset();
    usePreloadStore.getState().reset();
    clearPreloadRetryTimer();
    return null;
  }

  if (remainingMs <= 0) {
    playbackStore.reset();
    usePreloadStore.getState().reset();
    clearPreloadRetryTimer();
    return null;
  }

  // 优先从 ChatStore 获取下一段（支持手动切到旧段落后继续顺序播放）
  const currentMessageId = playbackStore.currentMessageId;

  if (currentMessageId) {
    const nextFromChat = useChatStore.getState().selectors.nextStorySegment(currentMessageId);
    if (nextFromChat) {
      // 释放 PreloadStore 的锁，允许后续预加载。
      // 仅当下一段是最新生成的消息时才操作，避免回放旧内容干扰生成流程。
      if (useChatStore.getState().selectors.isLatestMessage(nextFromChat.messageId)) {
        usePreloadStore.getState().consume();
      }

      usePlaybackStore.getState().advanceSegment();
      clearPreloadRetryTimer();

      return {
        audioUrl: nextFromChat.audioUrl,
        segment: nextFromChat.storyText,
        messageId: nextFromChat.messageId,
      };
    }
  }

  // ChatStore 中无后续段落，尝试从预加载 Store 获取。
  // 场景：当前播放的是最后一段，或者预加载的内容尚未同步到 ChatStore。
  // 中文注释：段落级故事播毕不得自动生成新聊天段，仅允许消费已存在的下一段；
  // 此处直接返回，避免 requestPreload 触发“请继续故事”并增殖卡片。

  let result: { segment: string; audioUrl: string; messageId?: string } | null = null;
  const progressStateForPreload = usePlaybackProgressStore.getState();
  if (progressStateForPreload.sourceId && progressStateForPreload.totalParagraphs > 0) {
    return null;
  }
  const preloadState = usePreloadStore.getState();

  try {
    // 强制触发消费预加载内容，即使状态已就绪。
    if (preloadState.status === 'ready') {
      usePreloadStore.getState().consume();
    }

    result = await usePreloadStore.getState().requestPreload();
  } catch (error) {
    if (error instanceof Error && error.message === 'PRELOAD_IN_PROGRESS') {
      return null;
    }
    return null;
  }

  if (!result) {
    return null;
  }

  // 消费本次生成产生的 ready 锁，避免阻塞下次预加载
  usePreloadStore.getState().consume();

  usePlaybackStore.getState().advanceSegment();
  clearPreloadRetryTimer();

  return {
    audioUrl: result.audioUrl,
    segment: result.segment,
    messageId: result.messageId,
  };
};

/**
 * 播放器开始播放时更新播放状态并启动倒计时。
 */
export const handlePlaybackStart = () => {
  usePlaybackStore.getState().start();
};

/**
 * 播放器暂停时同步状态，用于暂停倒计时与 UI。
 */
export const handlePlaybackPause = () => {
  usePlaybackStore.getState().pause();
};

/**
 * 播放进度推进时记录当前时间与总时长，供 UI 显示及其他逻辑使用。
 * @param payload.currentTime 当前播放位置（秒）
 * @param payload.duration 当前音频总时长（秒）
 */
export const updatePlaybackProgress = (payload: { currentTime: number; duration: number }) => {
  usePlaybackStore.getState().updateProgress(payload);
};

/**
 * 完整重置故事播放链路，清空播放、预加载与故事状态并取消定时器。
 */
export const resetStoryFlow = () => {
  usePlaybackProgressStore.getState().reset();
  usePlaybackStore.getState().reset();
  usePreloadStore.getState().reset();
  useGenerationStore.getState().reset();
  useChatStore.getState().resetChat();
  clearPreloadRetryTimer();
};
