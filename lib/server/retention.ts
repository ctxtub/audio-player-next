/**
 * StoryWork Retention 服务层（M2-09）
 *
 * 统一落地 Retention 语义：
 * 1. User active StoryWork 永不被自动删除（无论多老）；
 * 2. User Trash（deletedAt != null）仅按 30 天窗口 permanent purge：只有 deletedAt 早于 now-30d 的作品才可被清理，未到期不得动；
 * 3. 彻底无「数量 >100 就删旧作品」残余（任何 cleanup 路径严禁包含数量裁剪逻辑）；
 * 4. 并发安全（高风险）：自动 purge 与用户 Restore 竞争时，最终 delete 必须以 deletedAt IS NOT NULL 为原子条件；
 * 5. 统一 Service Seam：底层物理删除必须统一收敛委托至 lib/server/storyWork 的 executeStoryWorkPhysicalDelete 基底函数，
 *    严禁绕过基底裸调 prisma.storyWork.delete / deleteMany；该基底函数为后续 M8 对象存储音频清理的唯一 Service Seam；
 * 6. 访客数据 GC 收敛至既有 purgeExpiredGuestData（按行 30 天过期规则），本模块统一重导出以保持 API 面清晰干净。
 */

import { executeStoryWorkPhysicalDelete } from '@/lib/server/storyWork';
export { purgeExpiredGuestData, type PurgeResult, THIRTY_DAYS_MS } from '@/lib/server/guestGc';

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
 * 5. 架构说明（M8 Audio Seam 唯一执行点收敛）：
 *    本函数不直接操作 Prisma 删除，而是全权委托底层基底 primitive `executeStoryWorkPhysicalDelete`，
 *    仅负责计算并组装时间谓词（`deletedAt: { not: null, lt: threshold }`），避免 N+1 循环调用，
 *    并保证 M8 Audio tombstone 记录与音频清理仅挂载于基底 primitive 一处。
 *
 * @param now 基准时间（可选，默认当前时间）
 * @param testHooks 测试注入钩子（可选，供并发竞态回归测试使用）
 */
export async function purgeExpiredUserTrash(
  now?: Date,
  testHooks?: RetentionTestHooks
): Promise<{ purged: number }> {
  const currentTime = now ?? new Date();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const threshold = new Date(currentTime.getTime() - thirtyDaysMs);

  // 组装时间谓词，通过统一物理删除 primitive 执行批量条件删除
  const deleteResult = await executeStoryWorkPhysicalDelete({
    target: 'user',
    reason: 'trash',
    where: {
      deletedAt: {
        not: null,
        lt: threshold,
      },
    },
    testHooks,
  });

  return {
    purged: deleteResult.count,
  };
}
