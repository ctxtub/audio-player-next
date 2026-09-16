/**
 *   单轨音频（StoryAudio single-track）Feature Flag。
 *
 * 最终双 flag 契约（-r2 真去耦后，spec §7）：
 * - **server 单轨授权**只认运行时 `SINGLE_TRACK_AUDIO_ENABLED === '1'`
 *（见 `isSingleTrackServerEnabled`）。公开变量 `NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED`
 *   会被构建期内联、客户端可见，**绝不作为服务端授权依据**；仅置公开变量时，
 *   `storyAudio.ensure` / `getProjection` / `saveProgress`、
 *   `GET /api/audio/assets/:assetId`、`getPlaybackManifest` 单轨投影一律拒绝
 *（`SINGLE_TRACK_AUDIO_DISABLED` / 读取 404），**不产生任何单轨流量**。
 *   `ensureSegment` 恒为旧多段 canonical 路径，**不被单轨 flag 劫持**。
 * - **client provider 选择**（Work 播放是否走单轨资产）只认构建期内联
 *   `NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED === '1'`（或 E2E
 *   `globalThis.__SINGLE_TRACK_AUDIO_ENABLED === '1'`），见 `isSingleTrackAudioEnabled`；
 *   该函数不读运行时 `SINGLE_TRACK_AUDIO_ENABLED`。
 * - production 开启必须同时设置构建期 `NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED=1`
 *   与运行时 `SINGLE_TRACK_AUDIO_ENABLED=1`（Dockerfile ARG/ENV、compose build.args/
 *   environment、.env.sample 均已登记）：单独置其一 → client 不走单轨 / server 仍全拒，
 *   二者缺一不可。
 *
 * 生产默认：关闭（两变量缺席/非法值一律 false，fail closed）。
 * 本文件刻意零依赖（不读 window/document，不引 React），server/client/测试可共用。
 * client 侧必须写字面 `process.env.NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED` 成员访问
 *（Next 构建期内联；动态下标访问不会被内联，浏览器侧恒为 false）。
 */

/** 唯一合法开启值（严格相等，其余一律视为关闭，fail closed）。 */
export const SINGLE_TRACK_AUDIO_ENABLED_VALUE = '1';

/** 服务端授权环境表（只含运行时变量；单测可注入）。 */
export type SingleTrackServerEnvLike = {
  SINGLE_TRACK_AUDIO_ENABLED?: string | undefined;
};

/** 客户端 provider 选择环境表（只含公开变量；单测可注入）。 */
export type SingleTrackClientEnvLike = {
  NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED?: string | undefined;
};

/**
 * 服务端单轨授权判定：**只认运行时 `SINGLE_TRACK_AUDIO_ENABLED`**。
 *
 * `NEXT_PUBLIC_*` 会被构建期内联且对客户端可见，不能充当服务端授权依据，
 * 因此本函数刻意不读它。仅置公开变量时返回 false（服务端 fail closed）。
 *
 * @param env 可注入的环境表（单测用；缺省读 ambient process.env）
 * @returns 运行时变量严格为 '1' 时 true，否则 false（production 默认 false）
 */
export function isSingleTrackServerEnabled(env?: SingleTrackServerEnvLike): boolean {
  if (env !== undefined && env !== null) {
    return env.SINGLE_TRACK_AUDIO_ENABLED === SINGLE_TRACK_AUDIO_ENABLED_VALUE;
  }
  try {
    return process.env.SINGLE_TRACK_AUDIO_ENABLED === SINGLE_TRACK_AUDIO_ENABLED_VALUE;
  } catch {
    return false;
  }
}

/**
 * 客户端 provider 选择判定：只认构建期内联 `NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED`
 * 或 browser E2E `globalThis.__SINGLE_TRACK_AUDIO_ENABLED` 覆盖。
 *
 * 刻意不读运行时 `SINGLE_TRACK_AUDIO_ENABLED`（浏览器 bundle 无该值；服务端变量
 * 不得决定 client provider）。
 *
 * @param env 可注入的环境表（单测用；缺省读 ambient process.env）
 * @returns 公开变量或 E2E 覆盖严格为 '1' 时 true，否则 false（production 默认 false）
 */
export function isSingleTrackAudioEnabled(env?: SingleTrackClientEnvLike): boolean {
  if (env !== undefined && env !== null) {
    return env.NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED === SINGLE_TRACK_AUDIO_ENABLED_VALUE;
  }
  try {
    // oxlint-disable-next-line no-process-env -- client 构建内联必需字面访问
    if (process.env.NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED === SINGLE_TRACK_AUDIO_ENABLED_VALUE) {
      return true;
    }
  } catch {
    // ignore
  }
  try {
    const g = globalThis as unknown as Record<string, unknown>;
    if (g['__SINGLE_TRACK_AUDIO_ENABLED'] === SINGLE_TRACK_AUDIO_ENABLED_VALUE) return true;
  } catch {
    // ignore
  }
  return false;
}
