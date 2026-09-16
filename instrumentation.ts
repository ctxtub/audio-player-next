/**
 * Production Closure：Next 15 server instrumentation hook。
 *
 * 启动时跑一次有界 due-tombstone 清理（复用冻结的 cleanupAudioStorageDeletions
 * 引擎，经 `lib/server/audioStorageStartup.ts` 可测函数）。
 *
 * 钩子必须薄：
 * - 本文件只做 `NEXT_RUNTIME === 'nodejs'` 分支 + 动态 import + fire-and-forget，
 *   不直连 DB/存储/prisma（静态守卫锁定）；
 * - 核心逻辑全在 `runStartupAudioDeletionCleanup`（单测覆盖成功/失败不崩）；
 * - 启动清理失败不得崩服务：可测函数内部已捕获 + 日志 + 返回零结果，
 *   此处再包一层 try/catch（import 本身失败亦继续启动）。
 *
 * 不另造 lifecycle runner：不碰 `scripts/docker-start.sh`（Next 原生 hook 即
 * 唯一触发器；Next 15 无需 `experimental.instrumentationHook` 配置）。
 */

export const runtime = 'nodejs';

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const mod = await import('./lib/server/audioStorageStartup');
    void mod.runStartupAudioDeletionCleanup();
    // 单轨资产 30 天滑动 GC 启动触发（同一薄钩子，fire-and-forget，失败不崩）。
    void mod.runStartupStoryAudioAssetGc();
  } catch (err) {
    try {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        '[startup] audio deletion cleanup hook failed (non-fatal)',
        detail,
      );
    } catch {
      // 日志失败亦继续启动。
    }
  }
}
