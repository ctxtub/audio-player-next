/**
 * Collection Library ViewModel 纯函数（）。
 *
 * 职责：集合无限分页打平 + id 防重、成员 position 顺序校验、回收站可达性、
 * 末卡定位。绝不触碰网络与 React Query 缓存（UI 层组装）。
 */

import type {
  CollectionListOutput,
  CollectionWorkSummaryDTO,
  StoryCollectionSummaryDTO,
} from '@/lib/trpc/schemas/collection';

/** 跨页打平 + 按集合 id 防重（opaque cursor 守卫：只去重不重排）。 */
export function flattenCollectionPages(
  pages: CollectionListOutput[],
): StoryCollectionSummaryDTO[] {
  const seen = new Set<string>();
  const out: StoryCollectionSummaryDTO[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        out.push(item);
      }
    }
  }
  return out;
}

/** 集合详情是否可达（软删除集合 fail closed：无详情入口）。 */
export function isCollectionDetailAccessible(
  summary: StoryCollectionSummaryDTO,
): boolean {
  return summary.deletedAt == null;
}

/** 成员是否严格按 position 升序（服务端契约的客户端复核）。 */
export function areMemberPositionsOrdered(
  works: CollectionWorkSummaryDTO[],
): boolean {
  for (let i = 0; i < works.length; i += 1) {
    if (works[i]!.position !== i) return false;
  }
  return true;
}

/** 末张集合卡片 id（安全区断言定位用，无项时 null）。 */
export function findLastCollectionCardId(
  items: StoryCollectionSummaryDTO[],
): string | null {
  if (items.length === 0) return null;
  return items[items.length - 1]!.id;
}

/** 集合成员计数文案（零复数形态，中文恒定）。 */
export function formatCollectionWorkCount(workCount: number): string {
  return `${Math.max(0, Math.floor(workCount))} 个作品`;
}

/** 集合是否被收藏。 */
export function isCollectionFavorited(
  summary: StoryCollectionSummaryDTO,
): boolean {
  return summary.favoritedAt != null;
}
