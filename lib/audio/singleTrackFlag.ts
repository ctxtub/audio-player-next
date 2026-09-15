/**
 * M9-C1 T3 单轨音频（StoryAudio single-track）Feature Flag。
 *
 * 读路径（storyAudio.ensure / getProjection / GET /api/audio/assets/:assetId）
 * 仅当本开关显式开启时生效；关闭时完整回退旧 Segment canonical 路径，
 * 旧 `StoryAudioSegment` 与对象暂不物理删除（spec §7 回退点）。
 *
 * 生产默认：关闭（双变量缺席/非法值一律 false，fail closed）。
 * 本文件刻意零依赖（不读 window/document，不引 React），server/client/测试可共用。
 * client 侧必须写字面 `process.env.NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED` 成员访问
 *（Next 构建期内联；动态下标访问不会被内联，浏览器侧恒为 false）。
 */

/** 唯一合法开启值（严格相等，其余一律视为关闭，fail closed）。 */
export const SINGLE_TRACK_AUDIO_ENABLED_VALUE = '1';

/** 可注入的环境表（单测用；缺省读 ambient process.env）。 */
export type SingleTrackAudioEnvLike = {
  SINGLE_TRACK_AUDIO_ENABLED?: string | undefined;
  NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED?: string | undefined;
};

/**
 * 判定当前 runtime 是否允许单轨读路径。
 * @param env 可注入的环境表（单测用；缺省读 ambient process.env）
 * @returns 任一变量严格为 '1' 时 true，否则 false（production 默认 false）
 *
 * browser E2E 运行时覆盖：当显式注入 `globalThis.__SINGLE_TRACK_AUDIO_ENABLED === '1'`
 *（仅 browser spec 经 addInitScript 设置，每用例独立 context）时亦视为开启。
 */
export function isSingleTrackAudioEnabled(env?: SingleTrackAudioEnvLike): boolean {
  if (env !== undefined && env !== null) {
    return (
      env.SINGLE_TRACK_AUDIO_ENABLED === SINGLE_TRACK_AUDIO_ENABLED_VALUE ||
      env.NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED === SINGLE_TRACK_AUDIO_ENABLED_VALUE
    );
  }
  try {
    if (
      process.env.SINGLE_TRACK_AUDIO_ENABLED === SINGLE_TRACK_AUDIO_ENABLED_VALUE ||
      // oxlint-disable-next-line no-process-env -- client 构建内联必需字面访问
      process.env.NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED === SINGLE_TRACK_AUDIO_ENABLED_VALUE
    ) {
      return true;
    }
  } catch {
    return false;
  }
  try {
    const g = globalThis as unknown as Record<string, unknown>;
    if (g['__SINGLE_TRACK_AUDIO_ENABLED'] === SINGLE_TRACK_AUDIO_ENABLED_VALUE) return true;
  } catch {
    // ignore
  }
  return false;
}
