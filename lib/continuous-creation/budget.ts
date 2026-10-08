/** 自动播放时长与连续创作使用设置中的同一个有限时长。 */
import { useConfigStore } from '@/stores/configStore';
export function resolveContinuousCreationBudgetMinutes(): number {
  const minutes = useConfigStore.getState().apiConfig.defaultSleepTimerMinutes;
  return Number.isFinite(minutes) && minutes >= 10 && minutes <= 120 ? minutes : 30;
}
