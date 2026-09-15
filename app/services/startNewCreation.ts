/**
 * M9-C1 T2：唯一 `startNewCreation()` 强重置入口。
 *
 * 契约：`docs/specs/2026-09-15-story-collection-continuous-creation-technical-design.md` §5「新建创作」
 * 与 `docs/e2e/10-会话与作品集连续创作/07-新建创作强重置.md`。
 *
 * 顺序（不得拆散、不得各自 abort）：
 *   确认 → epoch++ → abort generation → pause/unload + clear Session/Anchor →
 *   reset runtime → createNew(expectedOldId) → 连续创作默认开启 + 预算快照。
 *
 * 远端失败保持无声安全态并允许重试，绝不恢复旧播放。
 */

import { createNewConversation } from '@/lib/client/conversation';
import { useChatStore } from '@/stores/chatStore';
import { useConfigStore } from '@/stores/configStore';
import { useContinuousCreationStore } from '@/stores/continuousCreationStore';
import { useGenerationStore } from '@/stores/generationStore';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import { usePlaybackStore } from '@/stores/playbackStore';

import { abortActiveChatStream } from './chatFlow';

/** `startNewCreation` 入参。 */
export type StartNewCreationOptions = {
  /** 客户端已知的旧 active 会话 id；用于防多标签页并发覆盖（服务端 CONFLICT）。 */
  expectedOldId?: string;
  /** 草稿/在途生成/未保存 Artifact 的确认；返回 false 则放弃（不产生任何副作用）。 */
  confirm?: () => boolean | Promise<boolean>;
  /** 测试注入：替换远端 createNew（隔离网络）。 */
  createNew?: (
    expectedOldId?: string,
  ) => Promise<{ id: string; collectionId: string | null }>;
};

/** `startNewCreation` 结果。 */
export type StartNewCreationResult = {
  /** 是否真正执行了强重置。 */
  started: boolean;
  /** declined = 用户取消；remote-failed = createNew 远端失败（保持安全态）。 */
  reason?: 'declined' | 'remote-failed';
  /** 本次新会话 epoch（旧回调凭此失效）。 */
  epoch: number;
  /** 新会话 id；远端失败时为 null。 */
  conversationId: string | null;
  /** 新会话对应集合 id；尚未晋升首作时为 null。 */
  collectionId: string | null;
};

/**
 * 解析本次会话预算快照（分钟）：设置页播放时长；定时关闭视为不限（0 → null）。
 * @returns 预算分钟数；0 表示不限。
 */
export function resolveContinuousCreationBudgetMinutes(): number {
  const { defaultSleepTimerEnabled, defaultSleepTimerMinutes } = useConfigStore.getState().apiConfig;
  if (!defaultSleepTimerEnabled) {
    return 0;
  }
  return typeof defaultSleepTimerMinutes === 'number' && defaultSleepTimerMinutes > 0
    ? defaultSleepTimerMinutes
    : 0;
}

/**
 * 唯一「新建创作」强重置入口。
 * @param options.expectedOldId 旧 active 会话 id。
 * @param options.confirm 确认回调。
 * @param options.createNew createNew 注入（测试）。
 * @returns 强重置结果。
 */
export async function startNewCreation(
  options: StartNewCreationOptions = {},
): Promise<StartNewCreationResult> {
  const currentEpoch = useContinuousCreationStore.getState().epoch;

  // 1) 确认（拒绝时不产生任何副作用）
  if (options.confirm) {
    const approved = await options.confirm();
    if (!approved) {
      return {
        started: false,
        reason: 'declined',
        epoch: currentEpoch,
        conversationId: null,
        collectionId: null,
      };
    }
  }

  // 2) 先 epoch++ 使旧回调失效（generation/promotion/audio/continuation 一律 no-op）
  const epoch = useContinuousCreationStore.getState().advanceEpoch();

  // 3) abort 在途 generation
  abortActiveChatStream();

  // 4) 停声：pause + reset transport，清 Playback Session/Anchor（blob 由 generation 侧吊销）
  try {
    usePlaybackSessionStore.getState().stop();
  } catch {
    // session 不可用时仅清 transport，不阻断强重置。
  }
  usePlaybackStore.getState().reset();
  useGenerationStore.getState().reset();

  // 5) reset message runtime
  useChatStore.getState().resetChat();

  // 6) createNew(expectedOldId)
  const budgetMinutes = resolveContinuousCreationBudgetMinutes();
  const createNew = options.createNew ?? createNewConversation;
  let conversationId: string | null = null;
  let collectionId: string | null = null;
  let reason: 'remote-failed' | undefined;
  try {
    const created = await createNew(options.expectedOldId);
    conversationId = created.id;
    collectionId = created.collectionId ?? null;
  } catch {
    reason = 'remote-failed';
  }

  // 7) 连续创作默认开启 + 预算快照（epoch 已递增，旧回调不会写回）
  useContinuousCreationStore.getState().resetForNewCreation({
    collectionId,
    budgetMinutes,
    epoch,
  });
  if (!useContinuousCreationStore.getState().enabled) {
    useContinuousCreationStore.getState().enable();
  }

  return { started: true, reason, epoch, conversationId, collectionId };
}
