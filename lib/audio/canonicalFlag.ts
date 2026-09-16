/**
 *  Canonical Audio Feature Flag（spec §39；）。
 *
 * Work 播放读路径（workId + segmentIndex + sessionId → storyAudio.ensureSegment
 * → /api/audio/segments/:segmentId）仅当本开关显式开启时生效；关闭时一律走
 * legacy ephemeral TTS（tts.synthesize → Blob），Draft 恒走旧路径不受开关影响。
 *
 * 生产默认：关闭（双变量缺席/非法值一律 false，fail closed）。
 *  CLOSED 前生产不得默认开启； 允许 test / explicit environment 开启：
 * 将 `CANONICAL_AUDIO_ENABLED=1`（server/node）或
 * `NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED=1`（client 构建内联）任一置为严格 '1'。
 *
 * 约束（spec §41：lifecycle 与正式 production canonical write 必须同时上线，
 * 不能先积累 S3 orphan）：本开关关闭时 playback 读路径永不调用 ensureSegment，
 * 故不产生新的 canonical 写入；已存在的合法资产不受开关影响（读路由仍按
 *  授权语义服务）。
 *
 * 本文件刻意零依赖（不读 window/document，不引 React），server/client/测试可共用。
 * client 侧必须写字面 `process.env.NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED` 成员访问
 *（Next 构建期内联；动态下标访问不会被内联，浏览器侧恒为 false）。
 */

/** 唯一合法开启值（严格相等，其余一律视为关闭，fail closed）。 */
export const CANONICAL_AUDIO_ENABLED_VALUE = '1';

/** 可注入的环境表（单测用；缺省读 ambient process.env）。 */
export type CanonicalAudioEnvLike = {
  CANONICAL_AUDIO_ENABLED?: string | undefined;
  NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED?: string | undefined;
};

/**
 * 判定当前 runtime 是否允许 Work 播放走 canonical 路径。
 * @param env 可注入的环境表（单测用；缺省读 ambient process.env）
 * @returns 任一变量严格为 '1' 时 true，否则 false（production 默认 false）
 *
 *  browser targeted 运行时覆盖：E2E harness 构建为单快照（全场景共享
 * 构建期 env），不能为单个 spec 开构建开关；故当显式注入
 * `globalThis.__CANONICAL_AUDIO_ENABLED === '1'`（仅 browser E2E spec 经
 * addInitScript 设置，每用例独立 context）时亦视为开启。生产 runtime 无此
 * global（且无 E2E probe 构建），保持 fail closed。
 */
export function isCanonicalAudioEnabled(env?: CanonicalAudioEnvLike): boolean {
  if (env !== undefined && env !== null) {
    return (
      env.CANONICAL_AUDIO_ENABLED === CANONICAL_AUDIO_ENABLED_VALUE ||
      env.NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED === CANONICAL_AUDIO_ENABLED_VALUE
    );
  }
  try {
    if (
      process.env.CANONICAL_AUDIO_ENABLED === CANONICAL_AUDIO_ENABLED_VALUE ||
      // oxlint-disable-next-line no-process-env -- client 构建内联必需字面访问
      process.env.NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED === CANONICAL_AUDIO_ENABLED_VALUE
    ) {
      return true;
    }
  } catch {
    return false;
  }
  try {
    const g = globalThis as unknown as Record<string, unknown>;
    if (g['__CANONICAL_AUDIO_ENABLED'] === CANONICAL_AUDIO_ENABLED_VALUE) return true;
  } catch {
    // ignore
  }
  return false;
}
