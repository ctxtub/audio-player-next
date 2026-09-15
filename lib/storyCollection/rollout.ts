/**
 * StoryCollection / Conversation 切换与回退开关（change-id 2026-09-15-story-collection-continuous-creation T1）。
 *
 * expand 阶段不收缩、不物理删除旧表；通过环境变量提供一键回退读与旧 History 停写能力：
 * - `STORY_COLLECTION_READS_ENABLED`（默认 true）：新会话/作品集读路径总开关；置 `'false'` 回退到旧单快照读，
 *   旧 `ChatMessage`（conversationId NULL）与旧 `GenerationHistory` 行仍在，可平滑回退。
 * - `LEGACY_HISTORY_READS_ENABLED`（默认 true）：旧 Prompt/Generation History 读路径开关，T2 退役时默认关闭。
 * - `LEGACY_HISTORY_WRITE_ENABLED`（默认 true 兼容）：旧 History 新写开关；T2 将其默认改为 false 并移除
 *   UI/store/router，T1 仅冻结开关名与默认值。
 *
 * 注意：T1 的新 Conversation/Collection/promotion 路径**结构性零 History 写入**（见 collection-domain 静态守卫），
 * 不依赖本开关；开关只服务于后续里程碑的物理停写与回退。
 */

export const STORY_COLLECTION_READS_ENABLED_ENV = 'STORY_COLLECTION_READS_ENABLED';
export const LEGACY_HISTORY_READS_ENABLED_ENV = 'LEGACY_HISTORY_READS_ENABLED';
export const LEGACY_HISTORY_WRITE_ENABLED_ENV = 'LEGACY_HISTORY_WRITE_ENABLED';

/** 缺省开启；显式 `'false'` 或 `'0'` 才关闭（避免误配静默关闭）。 */
function enabledUnlessExplicitlyFalse(value: string | undefined): boolean {
  return value !== 'false' && value !== '0';
}

export function isStoryCollectionReadsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return enabledUnlessExplicitlyFalse(env[STORY_COLLECTION_READS_ENABLED_ENV]);
}

export function isLegacyHistoryReadsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return enabledUnlessExplicitlyFalse(env[LEGACY_HISTORY_READS_ENABLED_ENV]);
}

export function isLegacyHistoryWriteEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return enabledUnlessExplicitlyFalse(env[LEGACY_HISTORY_WRITE_ENABLED_ENV]);
}

export type StoryCollectionRollout = {
  storyCollectionReads: boolean;
  legacyHistoryReads: boolean;
  legacyHistoryWrites: boolean;
};

/** 汇总当前切换状态（观测/证据用）。 */
export function resolveStoryCollectionRollout(
  env: Record<string, string | undefined> = process.env,
): StoryCollectionRollout {
  return {
    storyCollectionReads: isStoryCollectionReadsEnabled(env),
    legacyHistoryReads: isLegacyHistoryReadsEnabled(env),
    legacyHistoryWrites: isLegacyHistoryWriteEnabled(env),
  };
}
