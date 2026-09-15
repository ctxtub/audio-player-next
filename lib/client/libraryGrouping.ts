import type { LibraryView } from '@/lib/client/library';
import type { LibraryItemViewModel } from './libraryViewModel';

/**
 * 故事库时间分组标签类型
 *
 * 契约规范：
 * - 今天：用户设备本地时间当天 00:00:00 起
 * - 昨天：用户设备本地时间前一天 00:00:00 至 23:59:59
 * - 本周：用户设备本地时间本周一 00:00:00 起（除今天和昨天以外的部分）
 * - 更早：早于本周一 00:00:00 的所有时间
 */
export type TimeGroupLabel = '今天' | '昨天' | '本周' | '更早';

/**
 * 故事库时间分组结果结构
 */
export interface StoryWorkTimeGroup<TProgress = null> {
  label: TimeGroupLabel;
  items: LibraryItemViewModel<TProgress>[];
}

/**
 * 计算给定时间对应的时间分组标签（纯函数，支持显式注入 now 便于高精单元测试）
 *
 * @param dateInput 待分类的日期（ISO 字符串、Date 实例或时间戳）
 * @param now 参考基准时间（默认为当前时间）
 */
export function getTimeGroupLabel(
  dateInput: string | Date | number | null | undefined,
  now: Date = new Date()
): TimeGroupLabel {
  if (!dateInput) {
    return '更早';
  }

  const date = typeof dateInput === 'string' || typeof dateInput === 'number'
    ? new Date(dateInput)
    : dateInput;
  const time = date.getTime();

  // 无效时间戳防御性归入「更早」
  if (Number.isNaN(time)) {
    return '更早';
  }

  const nowYear = now.getFullYear();
  const nowMonth = now.getMonth();
  const nowDate = now.getDate();

  // 1. 今天 00:00:00.000
  const todayStart = new Date(nowYear, nowMonth, nowDate, 0, 0, 0, 0).getTime();
  if (time >= todayStart) {
    return '今天';
  }

  // 2. 昨天 00:00:00.000
  const yesterdayStart = new Date(nowYear, nowMonth, nowDate - 1, 0, 0, 0, 0).getTime();
  if (time >= yesterdayStart) {
    return '昨天';
  }

  // 3. 本周一 00:00:00.000 (0=周日, 1=周一, ..., 6=周六)
  const dayOfWeek = (now.getDay() + 6) % 7; // 周一映射为 0，周日映射为 6
  const thisWeekStart = new Date(nowYear, nowMonth, nowDate - dayOfWeek, 0, 0, 0, 0).getTime();
  if (time >= thisWeekStart) {
    return '本周';
  }

  // 4. 更早
  return '更早';
}

/**
 * 故事库作品统一时间分组函数
 *
 * 核心契约：
 * 1. 必须在所有分页（pages）打平（flatMap）后统一执行分组，严禁逐页分页分组；
 * 2. active / favorites 视图：以 createdAt 作为时间分组依据；
 * 3. trash 视图：以 deletedAt 作为时间分组依据（客户端提供 fail-safe 容错，缺失时回退至 createdAt）；
 * 4. 保持服务端原始排序（DESC），按 [今天, 昨天, 本周, 更早] 顺序输出；
 * 5. 过滤空分组，仅返回存在作品的分组。
 *
 * @param items 已打平的作品 ViewModel 数组
 * @param view 当前故事库视图类型 (active / favorites / trash)
 * @param now 参考基准时间（默认当前时间）
 */
export function groupStoryWorksByTime<TProgress = null>(
  items: LibraryItemViewModel<TProgress>[],
  view: LibraryView = 'active',
  now: Date = new Date()
): StoryWorkTimeGroup<TProgress>[] {
  if (!items || items.length === 0) {
    return [];
  }

  const buckets: Record<TimeGroupLabel, LibraryItemViewModel<TProgress>[]> = {
    '今天': [],
    '昨天': [],
    '本周': [],
    '更早': [],
  };

  for (const item of items) {
    // 视图分组字段边界：trash 依据 deletedAt（fail-safe 兜底 createdAt），其余依据 createdAt
    const rawDate =
      view === 'trash'
        ? (item.deletedAt ?? item.createdAt)
        : item.createdAt;

    const label = getTimeGroupLabel(rawDate, now);
    buckets[label].push(item);
  }

  const orderedLabels: TimeGroupLabel[] = ['今天', '昨天', '本周', '更早'];
  const result: StoryWorkTimeGroup<TProgress>[] = [];

  for (const label of orderedLabels) {
    if (buckets[label].length > 0) {
      result.push({
        label,
        items: buckets[label],
      });
    }
  }

  return result;
}
