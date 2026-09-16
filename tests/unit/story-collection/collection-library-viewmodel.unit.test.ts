/**
 * M9-C1 T4 L1 回归：Collection ViewModel 纯函数与底部占位纯函数。
 *
 * 覆盖集合分页打平防重、详情可达性、成员顺序复核、末卡定位、计数组装、
 * 收藏判定，以及 MainChrome 三占位变量解析（与 styles/app.module.scss 同构）。
 * 纯内存断言，不建 socket、不绑端口、不碰数据库。
 */

import assert from 'node:assert';

import {
  areMemberPositionsOrdered,
  findLastCollectionCardId,
  flattenCollectionPages,
  formatCollectionWorkCount,
  isCollectionDetailAccessible,
  isCollectionFavorited,
} from '../../../lib/client/collectionViewModel';
import {
  composeBottomChromeSafeBottom,
  resolveBottomChromeOccupancy,
} from '../../../lib/client/bottomInset';
import type {
  CollectionWorkSummaryDTO,
  StoryCollectionSummaryDTO,
} from '../../../lib/trpc/schemas/collection';

function summary(
  overrides: Partial<StoryCollectionSummaryDTO> & { id: string },
): StoryCollectionSummaryDTO {
  return {
    title: `集合${overrides.id}`,
    titleSource: 'fallback',
    workCount: 1,
    favoritedAt: null,
    deletedAt: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-09-02T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function member(id: number, position: number): CollectionWorkSummaryDTO {
  return {
    id,
    position,
    title: `作品${id}`,
  } as CollectionWorkSummaryDTO;
}

async function runCollectionLibraryViewModelTests(): Promise<void> {
  console.log('=== 1. 跨页打平 + id 防重（保序） ===');
  {
    const pages = [
      { items: [summary({ id: 'a' }), summary({ id: 'b' })], nextCursor: 'c1', hasMore: true },
      { items: [summary({ id: 'b' }), summary({ id: 'c' })], nextCursor: null, hasMore: false },
    ];
    const flat = flattenCollectionPages(pages);
    assert.deepStrictEqual(
      flat.map((s) => s.id),
      ['a', 'b', 'c'],
      '重复集合去重且保持服务端顺序',
    );
    console.log('PASS: 1');
  }

  console.log('=== 2. 软删除集合无详情入口 ===');
  {
    assert.strictEqual(isCollectionDetailAccessible(summary({ id: 'a' })), true);
    assert.strictEqual(
      isCollectionDetailAccessible(summary({ id: 't', deletedAt: new Date().toISOString() })),
      false,
      'trash 集合 fail closed',
    );
    console.log('PASS: 2');
  }

  console.log('=== 3. 成员 position 顺序复核 ===');
  {
    assert.strictEqual(areMemberPositionsOrdered([member(1, 0), member(2, 1), member(3, 2)]), true);
    assert.strictEqual(areMemberPositionsOrdered([]), true);
    assert.strictEqual(areMemberPositionsOrdered([member(1, 0), member(2, 2)]), false);
    assert.strictEqual(areMemberPositionsOrdered([member(1, 1), member(2, 0)]), false);
    console.log('PASS: 3');
  }

  console.log('=== 4. 末卡定位与计数文案 ===');
  {
    assert.strictEqual(findLastCollectionCardId([]), null);
    assert.strictEqual(
      findLastCollectionCardId([summary({ id: 'a' }), summary({ id: 'z' })]),
      'z',
    );
    assert.strictEqual(formatCollectionWorkCount(3), '3 个作品');
    assert.strictEqual(formatCollectionWorkCount(0), '0 个作品');
    console.log('PASS: 4');
  }

  console.log('=== 5. 收藏判定 ===');
  {
    assert.strictEqual(isCollectionFavorited(summary({ id: 'a' })), false);
    assert.strictEqual(
      isCollectionFavorited(summary({ id: 'f', favoritedAt: new Date().toISOString() })),
      true,
    );
    console.log('PASS: 5');
  }

  console.log('=== 6. 三占位变量解析（与 app.module.scss 同构） ===');
  {
    const off = resolveBottomChromeOccupancy(false);
    assert.strictEqual(off.tabBarVar, 'var(--tab-bar-safe-bottom)');
    assert.strictEqual(off.miniVar, '0px');
    assert.strictEqual(off.gapVar, '0px');
    const on = resolveBottomChromeOccupancy(true);
    assert.strictEqual(on.miniVar, 'var(--size-mini-now-playing-height)');
    assert.strictEqual(on.gapVar, 'var(--space-2)');
    assert.strictEqual(
      composeBottomChromeSafeBottom(on),
      'calc(var(--tab-bar-safe-bottom) + var(--size-mini-now-playing-height) + var(--space-2))',
    );
    console.log('PASS: 6');
  }

  console.log('ALL COLLECTION LIBRARY VIEWMODEL TESTS PASSED SUCCESSFULLY');
}

const testPromise = runCollectionLibraryViewModelTests().catch((err) => {
  console.error('collection-library-viewmodel test crashed:', err);
  process.exit(1);
});

export default testPromise;
