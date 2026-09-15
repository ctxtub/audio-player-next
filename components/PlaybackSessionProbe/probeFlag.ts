/**
 * M5-10 fixup-2：PlaybackSessionProbe E2E-only default-off 开关（评审 Blocking 1）。
 *
 * 背景：Probe 暴露真实 Flow 控制入口（begin/play/pause/checkpoint），会绕过 UI
 * 直接驱动内部 runtime，反向破坏 SessionFlow 封装；故普通 production runtime
 * 必须不可见（不挂载、无 window global、无隐藏 DOM 锚点），仅 browser test
 * runtime 显式开启后可用。
 *
 * 机制：构建时注入的显式 flag（`NEXT_PUBLIC_E2E_PLAYBACK_PROBE=1`），由 browser
 * harness 合成环境（tests/system/browser/harness/app-server.mjs）在快照构建与
 * 运行时统一注入；本地 `next dev/build` 与生产部署缺省无此变量 → fail closed。
 * 本文件刻意零依赖（不读 window/document，不引 React），server 组件与 client
 * 组件可共用同一判定，保证 layout 侧条件挂载与 Probe 内守卫同口径。
 *
 * 注意：client 侧必须写字面 `process.env.NEXT_PUBLIC_E2E_PLAYBACK_PROBE` 成员
 * 访问（Next 构建期内联）；动态下标访问不会被内联，浏览器侧恒为 false。
 */

/** 构建时注入的显式开启键（harness 合成环境设置，缺省关闭）。 */
export const PLAYBACK_PROBE_ENV_KEY = 'NEXT_PUBLIC_E2E_PLAYBACK_PROBE';

/** 唯一合法开启值（严格相等，其余一律视为关闭，fail closed）。 */
export const PLAYBACK_PROBE_ENABLED_VALUE = '1';

/**
 * 判定当前 runtime 是否允许挂载 PlaybackSessionProbe。
 * @param env 可注入的环境表（单测用；缺省读 ambient process.env）
 * @returns 仅当开启值严格为 '1' 时返回 true
 */
export function isPlaybackProbeEnabled(env?: {
  NEXT_PUBLIC_E2E_PLAYBACK_PROBE?: string;
}): boolean {
  if (env !== undefined && env !== null) {
    return env.NEXT_PUBLIC_E2E_PLAYBACK_PROBE === PLAYBACK_PROBE_ENABLED_VALUE;
  }
  try {
    return process.env.NEXT_PUBLIC_E2E_PLAYBACK_PROBE === PLAYBACK_PROBE_ENABLED_VALUE;
  } catch {
    return false;
  }
}

/**
 * 是否为 browser test runtime（Probe 唯一合法挂载环境）。
 * @returns 与 isPlaybackProbeEnabled() 同值（语义别名，供调用点自解释）
 */
export function isBrowserTestRuntime(): boolean {
  return isPlaybackProbeEnabled();
}
