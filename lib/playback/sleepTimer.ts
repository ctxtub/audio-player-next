/**
 *  Sleep Timer 领域语义（spec §21 / §22 / §22.1 / §23.1 / §24 / §29 / §31.1 / §32）。
 *
 * 本模块是 Sleep Timer 三态与数值规则的唯一纯函数 SSOT（无库/无 store 依赖，
 * unit 可直接导入；browser/integration 经 facade 复用同一规则）：
 * - 三态 off|minutes|story_end；story_end 仅 Work（Draft 不显示该选项，§22.1）；
 * - minutes 范围 10–120、step 10（与 server Zod 对齐，收口旧设置页 10–60 不一致，§31）；
 * - Legacy migration：remainingAllowedMs != null → minutes；== null → off
 *（§23.1，不得只依赖 schema default）；
 * - Existing user：defaultSleepTimerEnabled=true + 原 playDurationMinutes
 *（行为保持 30 分钟默认，§29.2 /）。
 */

/** Sleep Timer 三态（spec §22）。 */
export type SleepTimerMode = 'off' | 'minutes' | 'story_end';

/** 三态全集（server/client/UI 共用，避免各自手写字面量漂移）。 */
export const SLEEP_TIMER_MODES: readonly SleepTimerMode[] = ['off', 'minutes', 'story_end'];

/** minutes 允许范围（spec §31：统一 min 10 / max 120 / step 10）。 */
export const SLEEP_TIMER_MIN_MINUTES = 10;
export const SLEEP_TIMER_MAX_MINUTES = 120;
export const SLEEP_TIMER_STEP_MINUTES = 10;

/** 默认睡眠定时分钟数（与既有 playDurationMinutes @default(30) 对齐，§29.2）。 */
export const DEFAULT_SLEEP_TIMER_MINUTES = 30;

/** Expanded 快捷预设（spec §31.1：关闭 / 10 / 20 / 30 / 60 / 自定义 / 本故事结束后）。 */
export const SLEEP_TIMER_PRESET_MINUTES: readonly number[] = [10, 20, 30, 60];

/** 一分钟毫秒数（setSleepTimer remaining/total 换算，spec §24）。 */
export const SLEEP_TIMER_MINUTE_IN_MS = 60000;

/**
 * 是否为合法 SleepTimerMode（Anchor DTO 映射 / repair 的 fail-closed 门）。
 */
export const isValidSleepTimerMode = (value: unknown): value is SleepTimerMode =>
  value === 'off' || value === 'minutes' || value === 'story_end';

/**
 * 是否为合法 minutes（整数 + 10–120；step 10 由 UI 侧约束，server 接受区间内任意整数）。
 */
export const isValidSleepTimerMinutes = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= SLEEP_TIMER_MIN_MINUTES &&
  value <= SLEEP_TIMER_MAX_MINUTES;

/**
 * minutes → 毫秒预算（spec §24：remaining = total = minutes × 60_000）。
 * 非法输入返回 null（调用方 fail-closed，不得落库）。
 */
export const sleepTimerMinutesToMs = (minutes: number): number | null => {
  if (!isValidSleepTimerMinutes(minutes)) return null;
  return minutes * SLEEP_TIMER_MINUTE_IN_MS;
};

/**
 * Legacy migration 纯规则（spec §23.1）：
 * remainingAllowedMs != null → minutes；== null → off。
 * 0 视为已耗尽的过期态 → off（配合到期规则，杜绝旧 remainingMs<=0 永久锁死，§26）。
 */
export const resolveSleepTimerModeFromLegacy = (
  remainingAllowedMs: number | null | undefined,
): SleepTimerMode => {
  if (typeof remainingAllowedMs === 'number' && remainingAllowedMs > 0) return 'minutes';
  return 'off';
};

/**
 * Sleep Timer 三元组归一（spec §23.1/§26 全局不变式，begin/checkpoint/DTO/repair 共用 SSOT）：
 * 预算只存在于 minutes 模式（remaining!=null ⟺ mode==minutes）。
 * - remaining==0 → null（过期残留，不再以 0 持久化，§26）；
 * - remaining>0：stored 合法则信任 stored（显式 off/story_end 优先于派生；
 *   §23.1 的“预算→minutes”只适用于 mode 缺席的 legacy 派生），非法 stored → minutes；
 *   非 minutes 模式预算清零（off/story_end 恒 null）；
 * - 其余（null/<=0）：story_end 保留，其余 off，预算 null。
 */
export const normalizeSleepTimerTriple = (
  stored: unknown,
  remainingAllowedMs: number | null | undefined,
  totalAllowedMs: number | null | undefined,
): { mode: SleepTimerMode; remainingMs: number | null; totalMs: number | null } => {
  const remaining =
    remainingAllowedMs === 0 ? null : (remainingAllowedMs ?? null);
  const rawTotal = totalAllowedMs === 0 ? null : (totalAllowedMs ?? null);
  const total = remainingAllowedMs === 0 ? null : rawTotal;
  if (typeof remaining === 'number' && remaining > 0) {
    if (stored === 'off' || stored === 'story_end') {
      return { mode: stored, remainingMs: null, totalMs: null };
    }
    // stored 为 minutes 或缺席/非法（legacy 行无 mode 列值）→ minutes（§23.1 派生）。
    return { mode: 'minutes', remainingMs: remaining, totalMs: total };
  }
  if (stored === 'story_end') {
    return { mode: 'story_end', remainingMs: null, totalMs: null };
  }
  return { mode: 'off', remainingMs: null, totalMs: null };
};

/**
 * Anchor 一致性修复纯规则（migration SQL + getAnchor repair 共用）：
 * normalizeSleepTimerTriple 的 mode 投影（保留旧名，调用方兼容）。
 */
export const resolveConsistentSleepTimerMode = (
  stored: unknown,
  remainingAllowedMs: number | null | undefined,
): SleepTimerMode =>
  normalizeSleepTimerTriple(stored, remainingAllowedMs, undefined).mode;

/**
 * 是否为 Work source（story_end 选项门，spec §22.1/§24：only work）。
 * Draft（含 extendable 语义模糊）一律 false。
 */
export const canUseStoryEndTimer = (sourceKind: 'draft' | 'work'): boolean =>
  sourceKind === 'work';

/**
 * 新 Session 默认 Timer 纯规则（spec §28/§29.2/§62）：
 * - defaultEnabled=false → off（remaining/total null）；
 * - defaultEnabled=true → minutes（remaining/total = minutes × 60_000）。
 * Session 切换一律走此规则重新计算，不继承旧 Session remaining（§28）。
 */
export const resolveDefaultSessionTimer = (params: {
  defaultEnabled: boolean;
  defaultMinutes: number;
}): { mode: SleepTimerMode; remainingMs: number | null; totalMs: number | null } => {
  const minutes = isValidSleepTimerMinutes(params.defaultMinutes)
    ? params.defaultMinutes
    : DEFAULT_SLEEP_TIMER_MINUTES;
  if (!params.defaultEnabled) {
    return { mode: 'off', remainingMs: null, totalMs: null };
  }
  const budgetMs = minutes * SLEEP_TIMER_MINUTE_IN_MS;
  return { mode: 'minutes', remainingMs: budgetMs, totalMs: budgetMs };
};

/**
 * setSleepTimer 落库值纯规则（spec §24）：
 * - off → remaining=null, total=null；
 * - minutes → remaining=total=minutes×60_000（minutes 非法返回 null，调用方 BAD_REQUEST）；
 * - story_end → remaining=null, total=null（仅 Work，调用方另行门禁）。
 */
export const resolveSetSleepTimerValues = (
  mode: SleepTimerMode,
  minutes?: number,
): { mode: SleepTimerMode; remainingMs: number | null; totalMs: number | null } | null => {
  if (mode === 'off') return { mode: 'off', remainingMs: null, totalMs: null };
  if (mode === 'story_end') return { mode: 'story_end', remainingMs: null, totalMs: null };
  const budgetMs = typeof minutes === 'number' ? sleepTimerMinutesToMs(minutes) : null;
  if (budgetMs === null) return null;
  return { mode: 'minutes', remainingMs: budgetMs, totalMs: budgetMs };
};

/**
 * 到期归一值（spec §26  新规则）：
 * pause → save checkpoint → mode=off, remaining=null, total=null；
 * Session 保留 paused；之后 Play 正常继续（null 预算不受 <=0 守卫影响）。
 */
export const SLEEP_TIMER_EXPIRED_STATE = {
  mode: 'off',
  remainingMs: null,
  totalMs: null,
} as const;

/**
 * 完播/新默认复位值（spec §27：无论何种 timer 模式，completeSession 后 Timer reset off）。
 */
export const SLEEP_TIMER_RESET_STATE = {
  mode: 'off',
  remainingMs: null,
  totalMs: null,
} as const;

/**
 * 剩余毫秒 → “MM:SS 后暂停”展示（spec §32 minutes 形态）。
 * 非正/非法回退空串（调用方此时应展示 off 形态）。
 */
export const formatSleepTimerRemaining = (remainingMs: number | null | undefined): string => {
  if (typeof remainingMs !== 'number' || !Number.isFinite(remainingMs) || remainingMs <= 0) {
    return '';
  }
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(minutes)}:${pad(seconds)}`;
};
