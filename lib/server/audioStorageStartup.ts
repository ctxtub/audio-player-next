/**
 * M8-05-04 Production Closure：启动时有界 due-tombstone 清理（可测核心）。
 *
 * 本模块是 `instrumentation.ts` register() 钩子的唯一可测实现：
 * 复用冻结的 `cleanupAudioStorageDeletions`（M8-05-01 引擎），单次消费有界
 * （DEFAULT 上限钳制），失败永不抛（返回零结果 + 日志），保证启动清理失败
 * 不得崩服务。
 *
 * 约束：
 * - 不新增 lifecycle runner：不碰 `scripts/docker-start.sh`；
 * - 不改 canonicalFlag 语义、不触 M7 P3B、不做 schema 变更。
 */

import {
  AUDIO_DELETION_DEFAULT_LIMIT,
  cleanupAudioStorageDeletions,
  type CleanupAudioStorageDeletionsResult,
} from '@/lib/server/audioStorageCleanup';

/** 启动清理单次消费上限（复用冻结引擎 DEFAULT；MAX 钳制由引擎内部保证）。 */
export const STARTUP_AUDIO_CLEANUP_LIMIT = AUDIO_DELETION_DEFAULT_LIMIT;

/** 启动清理 runner（缺省直调冻结引擎；单测注入 fake）。 */
export type StartupAudioCleanupRunner = (options: {
  limit: number;
}) => Promise<CleanupAudioStorageDeletionsResult>;

/** 启动清理日志面（缺省 console；单测注入静默 fake）。 */
export type StartupAudioCleanupLogger = Pick<
  Console,
  'warn' | 'info' | 'error'
>;

/** 启动清理可注入选项。 */
export type RunStartupAudioDeletionCleanupOptions = {
  /** 后端消费实现（缺省冻结引擎）。 */
  runner?: StartupAudioCleanupRunner;
  /** 日志（缺省 console）。 */
  logger?: StartupAudioCleanupLogger;
  /** 消费上限（缺省 STARTUP_AUDIO_CLEANUP_LIMIT；引擎内再钳制）。 */
  limit?: number;
};

/** 启动清理零结果（失败/空跑统一形状，调用方永不判错）。 */
export const STARTUP_AUDIO_CLEANUP_EMPTY_RESULT: CleanupAudioStorageDeletionsResult =
  {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    attemptedKeys: [],
  };

/**
 * 启动时跑一次有界 due-tombstone 清理。
 *
 * 成功返回引擎原样结果；任何失败（DB 不可达、存储抛错、runner 本身抛错）
 * 均捕获 + 日志 + 返回零结果，绝不抛错（启动钩子可 fire-and-forget）。
 */
export async function runStartupAudioDeletionCleanup(
  options: RunStartupAudioDeletionCleanupOptions = {},
): Promise<CleanupAudioStorageDeletionsResult> {
  const limit = options.limit ?? STARTUP_AUDIO_CLEANUP_LIMIT;
  const runner =
    options.runner ??
    ((opts: { limit: number }) =>
      cleanupAudioStorageDeletions({ limit: opts.limit }));
  const logger = options.logger ?? console;
  try {
    return await runner({ limit });
  } catch (err) {
    try {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn?.(
        '[startup] audio deletion cleanup failed (non-fatal, will retry opportunistically)',
        detail,
      );
    } catch {
      // 日志本身失败亦不得崩启动。
    }
    return { ...STARTUP_AUDIO_CLEANUP_EMPTY_RESULT };
  }
}

/**
 * T3 单轨资产 30 天滑动 GC 启动触发（薄包装，动态 import 避免启动模块静态拉入 DB/存储）。
 *
 * 无节流跑一次有界清扫；任何失败吞错（启动清理失败不得崩服务）。
 */
export async function runStartupStoryAudioAssetGc(): Promise<void> {
  try {
    const mod = await import('@/lib/server/storyAudioAsset');
    await mod.runStartupStoryAudioAssetGc();
  } catch (err) {
    try {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn('[startup] story audio asset GC failed (non-fatal)', detail);
    } catch {
      // 日志失败亦继续启动。
    }
  }
}
