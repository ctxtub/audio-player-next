/**
 * M9-C1 T2：连续创作会话预算快照解析（中性模块，避免 store↔service 成环）。
 *
 * 预算口径：设置页「播放时长」；定时关闭或 <=0/缺失视为「不限」（0 分钟）。
 * `startNewCreation` 与 `continuousCreationFlow.switchCollection` 重新初始化共用此口径。
 */

import { useConfigStore } from '@/stores/configStore';

/**
 * 解析本次会话预算快照（分钟）：设置页播放时长；定时关闭视为不限（0 → null）。
 * @returns 预算分钟数；0 表示不限。
 */
export function resolveContinuousCreationBudgetMinutes(): number {
  const { defaultSleepTimerEnabled, defaultSleepTimerMinutes } = useConfigStore.getState().apiConfig;
  if (!defaultSleepTimerEnabled) {
    return 0;
  }
  return typeof defaultSleepTimerMinutes === 'number' && defaultSleepTimerMinutes > 0
    ? defaultSleepTimerMinutes
    : 0;
}
