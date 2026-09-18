/**
 * 唯一 `startNewCreation()` 强重置入口。
 *
 * 产品契约见 `docs/archive/product-decisions.md` 的“创作体验”。
 * 用户触发后必须中止旧生成、停止播放并恢复创作初始状态。
 *
 * 顺序（不得拆散、不得各自 abort）：
 *   确认 → epoch++ → abort generation → pause/unload + clear Session/Anchor →
 *   reset runtime → createNew(expectedOldId) → 连续创作默认开启 + 预算快照。
 *
 * 远端失败保持无声安全态并允许重试，绝不恢复旧播放。
 */

import { createNewConversation } from '@/lib/client/conversation';
import { resolveContinuousCreationBudgetMinutes } from '@/lib/continuous-creation/budget';
import { useChatStore } from '@/stores/chatStore';
import { useContinuousCreationStore } from '@/stores/continuousCreationStore';
import { useGenerationStore } from '@/stores/generationStore';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import { usePlaybackStore } from '@/stores/playbackStore';

import { cancelPendingNextWork } from './continuousCreationFlow';

/** 预算快照解析（保持既有公共出口，供测试/调用方复用）。 */
export { resolveContinuousCreationBudgetMinutes };

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
  //（评审闭合项 3）：在重置前捕获当前会话 id，作为旧会话校验值传给 createNew。
  // 多标签页/竞态下服务端凭它与真实 active 比对，不匹配即 CONFLICT，绝不静默覆盖。
  const capturedOldConversationId = useChatStore.getState().conversationId ?? undefined;

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
  useContinuousCreationStore.getState().advanceEpoch();

  // 3)+4) 经真取消 seam：abort 在途 generation/ensure 等待，并清空连续创作编排运行时
  //（准备中的下一作品、调度在途、audio 采样点、下一篇展示身份）。
  cancelPendingNextWork();

  // 5) 停声并清空 Playback Session（reset 会换掉 sessionId，旧会话迟到的 TTS/段落
  //    回调凭 sessionId 失配 no-op，绝不复活播放；reset transport 清 <audio> 与 Blob）。
  try {
    usePlaybackSessionStore.getState().reset();
  } catch {
    // session 不可用时仅清 transport，不阻断强重置。
  }
  usePlaybackStore.getState().reset();
  useGenerationStore.getState().reset();

  // 6) reset message runtime（保留服务端旧会话，仅本地清空身份）
  useChatStore.getState().resetChat();

  // 7) createNew(expectedOldId)；优先显式入参，否则用步骤 1 捕获的旧会话 id。
  const budgetMinutes = resolveContinuousCreationBudgetMinutes();
  const createNew = options.createNew ?? createNewConversation;
  const expectedOldId = options.expectedOldId ?? capturedOldConversationId;
  let conversationId: string | null = null;
  let collectionId: string | null = null;
  let reason: 'remote-failed' | undefined;
  try {
    const created = await createNew(expectedOldId);
    conversationId = created.id;
    collectionId = created.collectionId ?? null;
  } catch {
    reason = 'remote-failed';
  }

  // 8) 连续创作默认开启 + 预算快照（epoch 已递增，旧回调不会写回）
  if (conversationId !== null) {
    // 创作页围绕新 active Conversation 运行（identity 读路径）。
    useChatStore.getState().applyConversationIdentity({
      conversationId,
      collectionId,
      collectionTitle: null,
    });
  }
  // applyConversationIdentity 经 switchCollection 推进连续创作 epoch；以其后快照为准。
  const epoch = useContinuousCreationStore.getState().epoch;
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
