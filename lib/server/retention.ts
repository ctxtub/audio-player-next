/**
 * StoryWork Retention 与垃圾回收 (GC) 服务层（M2-09）
 *
 * 落地统一的 Retention / GC 语义（服务端清理任务/服务层）：
 * 1. User active StoryWork 永不被自动删除（无论多老）；
 * 2. User Trash（deletedAt != null）仅按 30 天窗口 permanent purge：只有 deletedAt 早于 now-30d 的作品才可被清理，未到期不得动；
 * 3. Guest StoryWork 按 Guest inactivity 30 天整体 GC（以既有 Guest 会话/交互记录口径判定全表活跃度）；
 * 4. 彻底无「数量 >100 就删旧作品」残余（任何 cleanup 路径严禁包含数量裁剪逻辑）；
 * 5. 并发安全（高风险）：自动 purge 与用户 Restore 竞争时，最终 delete 必须以 deletedAt IS NOT NULL 为原子条件
 *    （复用 M2-05 的条件写模式：deleteMany where { deletedAt: { not: null, lt: threshold } } + count；禁止先读后按 id 裸写）；
 * 6. Service Seam 模式：本模块提供清晰可调用的入口函数，供后续调度器/Cron 调用；预留 M8 对象存储音频物理清理缝隙。
 */

import { prisma } from '@/lib/db';

/** 30 天毫秒数常量（Retention 窗口标准） */
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Retention / GC 内部测试注入钩子（供并发竞态与时序注入回归使用，生产调用方严禁传入）
 */
export interface RetentionTestHooks {
  /** 在执行原子 SQL 删除前执行的钩子 */
  __testBeforeMutationHook?: () => Promise<void> | void;
}

/**
 * 清理过期用户回收站作品（M2-09）
 *
 * 严格语义：
 * 1. 仅物理删除 deletedAt IS NOT NULL 且 deletedAt 早于 30 天前（now - 30d）的记录；
 * 2. User active 作品（deletedAt === null）无论多老绝对不删；
 * 3. 未到期的回收站作品（deletedAt 在 30 天内）严格保留；
 * 4. 并发原子性：以原子 SQL 条件写执行（where deletedAt IS NOT NULL AND deletedAt < threshold），
 *    杜绝 TOCTOU 竞态。若与用户 restore 操作并发发生，已恢复为 active 的作品绝不会被误删；
 * 5. 架构说明（M8 Audio Seam）：
 *    后续 M8 在执行批量物理清理时，将在此处基于待删除集合生成 Audio tombstone 记录并协同触发
 *    对象存储音频文件清理，删除作品时依然严格保持原子条件删除，严禁裸删 ID。
 *
 * @param now 基准时间（可选，默认当前时间）
 * @param testHooks 测试注入钩子（可选，供并发竞态回归测试使用）
 */
export async function purgeExpiredUserTrash(
  now?: Date,
  testHooks?: RetentionTestHooks
): Promise<{ purged: number }> {
  const currentTime = now ?? new Date();
  const threshold = new Date(currentTime.getTime() - THIRTY_DAYS_MS);

  if (testHooks?.__testBeforeMutationHook) {
    await testHooks.__testBeforeMutationHook();
  }

  // 原子条件写：严格限制 deletedAt IS NOT NULL 且小于截止时间
  // 杜绝先读后裸删 ID 产生的 TOCTOU 漏洞
  const deleteResult = await prisma.storyWork.deleteMany({
    where: {
      deletedAt: {
        not: null,
        lt: threshold,
      },
    },
  });

  return {
    purged: deleteResult.count,
  };
}

/**
 * 判定指定 guestId 在 30 天窗口内是否存在任何活跃行为（会话记录口径）
 *
 * 口径说明：
 * 系统未设置单独的 Guest 实体表及 lastAccessTime 字段，因此按既有 Guest 数据表的最新交互时间
 * （GuestChatMessage, GuestStoryWork, GuestPromptHistory, GuestPlaybackProgress, GuestConfig）
 * 综合判定：只要该访客在任一表中有 >= threshold 的记录，即认定该访客处于活跃状态。
 */
async function isGuestActiveInWindow(guestId: string, threshold: Date): Promise<boolean> {
  // 1. 聊天消息更新
  const recentChat = await prisma.guestChatMessage.findFirst({
    where: { guestId, updatedAt: { gte: threshold } },
    select: { id: true },
  });
  if (recentChat) return true;

  // 2. 故事作品创建或更新
  const recentWork = await prisma.guestStoryWork.findFirst({
    where: {
      guestId,
      OR: [
        { updatedAt: { gte: threshold } },
        { createdAt: { gte: threshold } },
      ],
    },
    select: { id: true },
  });
  if (recentWork) return true;

  // 3. 提示词历史使用或更新
  const recentPrompt = await prisma.guestPromptHistory.findFirst({
    where: {
      guestId,
      OR: [
        { updatedAt: { gte: threshold } },
        { lastUsed: { gte: threshold } },
      ],
    },
    select: { id: true },
  });
  if (recentPrompt) return true;

  // 4. 断点续播更新
  const recentProgress = await prisma.guestPlaybackProgress.findFirst({
    where: { guestId, updatedAt: { gte: threshold } },
    select: { id: true },
  });
  if (recentProgress) return true;

  // 5. 个性化偏好更新
  const recentConfig = await prisma.guestConfig.findFirst({
    where: { guestId, updatedAt: { gte: threshold } },
    select: { id: true },
  });
  if (recentConfig) return true;

  return false;
}

/**
 * 回收 30 天不活跃访客的所有作品及关联数据（M2-09）
 *
 * 严格语义：
 * 1. 整体按 Guest 活跃度判断，而非作品创建单条时间：
 *    - 活跃访客（30 天内有任何交互）：即使其拥有的部分作品创建早于 30 天，也绝对不 GC 保留完整；
 *    - 不活跃访客（30 天内全无交互）：整账号作品全量永久清理；
 * 2. 严格租户隔离：User 数据绝对不受任何 Guest GC 影响；
 * 3. 绝对不设作品数量上限（无 >100 裁剪逻辑）；
 * 4. 架构说明（M8 Audio Seam）：
 *    后续 M8 在回收不活跃访客作品时，将协同触发关联对象存储音频清理。
 *
 * @param now 基准时间（可选，默认当前时间）
 * @param testHooks 测试注入钩子（可选）
 */
export async function gcInactiveGuests(
  now?: Date,
  testHooks?: RetentionTestHooks
): Promise<{ purgedGuests: number; purgedWorks: number }> {
  const currentTime = now ?? new Date();
  const threshold = new Date(currentTime.getTime() - THIRTY_DAYS_MS);

  // 收集当前库中所有拥有故事作品的访客候选集合
  const candidateRows = await prisma.guestStoryWork.findMany({
    select: { guestId: true },
    distinct: ['guestId'],
  });

  const inactiveGuestIds: string[] = [];

  for (const row of candidateRows) {
    const isActive = await isGuestActiveInWindow(row.guestId, threshold);
    if (!isActive) {
      inactiveGuestIds.push(row.guestId);
    }
  }

  if (testHooks?.__testBeforeMutationHook) {
    await testHooks.__testBeforeMutationHook();
  }

  let purgedWorks = 0;

  if (inactiveGuestIds.length > 0) {
    // 物理清理不活跃访客的所有作品
    const deleteResult = await prisma.guestStoryWork.deleteMany({
      where: {
        guestId: { in: inactiveGuestIds },
      },
    });
    purgedWorks = deleteResult.count;

    // 连带清理不活跃访客的其他孤儿记录（会话、提示词、播放进度、配置）
    await prisma.guestChatMessage.deleteMany({
      where: { guestId: { in: inactiveGuestIds } },
    });
    await prisma.guestPromptHistory.deleteMany({
      where: { guestId: { in: inactiveGuestIds } },
    });
    await prisma.guestPlaybackProgress.deleteMany({
      where: { guestId: { in: inactiveGuestIds } },
    });
    await prisma.guestConfig.deleteMany({
      where: { guestId: { in: inactiveGuestIds } },
    });
  }

  return {
    purgedGuests: inactiveGuestIds.length,
    purgedWorks,
  };
}
