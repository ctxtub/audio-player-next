import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const repoRoot = process.cwd();

// 1. 安装样式桩（SCSS/CSS）
function installAssetStubs(): void {
  const extTable = (
    nodeRequire as unknown as {
      extensions: Record<string, (m: NodeModule, f: string) => void>;
    }
  ).extensions;
  if (extTable && !extTable['.scss']) {
    const scssStub = (m: NodeModule): void => {
      const proxy = new Proxy(
        {},
        {
          get: (_t: object, p: string | symbol): unknown => {
            if (p === '__esModule') {
              return true;
            }
            return String(p);
          },
        }
      );
      (m as unknown as { exports: unknown }).exports = proxy;
    };
    extTable['.scss'] = scssStub as (m: NodeModule, f: string) => void;
    extTable['.css'] = scssStub as (m: NodeModule, f: string) => void;
  }
}

// 2. 搭建 JSDOM 环境
let activeObserverCallback: ((entries: any[], observer: any) => void) | null = null;
let activeObserverInstance: any = null;

function setupJsdom(): void {
  const { JSDOM } = nodeRequire('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost:3000/library',
    pretendToBeVisual: true,
  });
  const win = dom.window as Record<string, unknown>;
  const g = globalThis as Record<string, unknown>;

  const copyKeys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLTextAreaElement',
    'HTMLInputElement',
    'HTMLButtonElement',
    'Element',
    'Node',
    'Text',
    'DocumentFragment',
    'Event',
    'CustomEvent',
    'MouseEvent',
    'KeyboardEvent',
    'FocusEvent',
    'SVGElement',
    'NodeFilter',
    'NodeList',
    'MutationObserver',
    'getComputedStyle',
  ];

  for (const key of copyKeys) {
    if (key === 'window') {
      try {
        Object.defineProperty(g, 'window', { value: win, writable: true, configurable: true });
      } catch {
        // ignore
      }
      continue;
    }
    let value = win[key];
    if (key === 'getComputedStyle' && typeof value === 'function') {
      value = (value as (e: unknown) => unknown).bind(win);
    }
    if (value !== undefined) {
      try {
        Object.defineProperty(g, key, { value, writable: true, configurable: true });
      } catch {
        // 忽略 Node 22 等环境内置只读属性（如 navigator）
      }
    }
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;

  // Mock IntersectionObserver
  class MockIntersectionObserver {
    readonly root: Element | Document | null = null;
    readonly rootMargin: string = '';
    readonly thresholds: ReadonlyArray<number> = [];
    private callback: any;

    constructor(callback: any, options?: any) {
      this.callback = callback;
      activeObserverCallback = callback;
      activeObserverInstance = this;
      if (options?.rootMargin) this.rootMargin = options.rootMargin;
    }

    observe = () => {};
    unobserve = () => {};
    disconnect = () => {
      if (activeObserverInstance === this) {
        activeObserverInstance = null;
        activeObserverCallback = null;
      }
    };
    takeRecords = () => [];
  }
  g.IntersectionObserver = MockIntersectionObserver;
}

// 3. 准备 JSDOM 与模块
setupJsdom();
installAssetStubs();

// 使用支持 JSX 的 innerJiti 载入 .tsx 组件与领域函数
const jitiFactory = nodeRequire('jiti');
const innerJiti = jitiFactory(path.join(repoRoot, 'index.js'), {
  alias: { '@': repoRoot },
  jsx: true,
});

const {
  groupStoryWorksByTime,
  getTimeGroupLabel,
} = innerJiti('./lib/client/libraryGrouping.ts');

const {
  composeLibraryItemViewModel,
  composeLibraryItemListViewModel,
} = innerJiti('./lib/client/libraryViewModel.ts');

const { StoryWorkCard } = innerJiti('./app/(main)/library/components/StoryWorkCard.tsx');
const { LibraryToolbar } = innerJiti('./app/(main)/library/components/LibraryToolbar.tsx');
const { LibraryTimeGroup } = innerJiti('./app/(main)/library/components/LibraryTimeGroup.tsx');
const { InfiniteScrollSentinel } = innerJiti('./app/(main)/library/components/InfiniteScrollSentinel.tsx');
const { LibraryEmptyState } = innerJiti('./app/(main)/library/components/LibraryEmptyState.tsx');
const { LibraryLoadingSkeleton } = innerJiti('./app/(main)/library/components/LibraryLoadingSkeleton.tsx');
const { LibraryErrorState } = innerJiti('./app/(main)/library/components/LibraryErrorState.tsx');

const { render, fireEvent, act, cleanup } = nodeRequire('@testing-library/react');

import type { StoryWorkSummaryDTO } from '@/lib/client/library';
import type { LibraryItemViewModel } from '@/lib/client/libraryViewModel';

/**
 * 构造测试用 StoryWorkSummaryDTO 工厂函数
 */
function createMockStory(overrides: Partial<StoryWorkSummaryDTO> = {}): StoryWorkSummaryDTO {
  return {
    id: 1,
    title: '测试故事',
    excerpt: '这是故事摘要内容...',
    voiceId: 'zh-CN-XiaoxiaoNeural',
    contentHash: 'hash-abc-123',
    favoritedAt: null,
    deletedAt: null,
    createdAt: new Date('2026-09-16T10:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-09-16T10:00:00.000Z').toISOString(),
    audio: {
      status: 'ready',
      durationMs: 125000,
    },
    ...overrides,
  };
}

/**
 * 运行 M3-04 故事库列表读取 UI 与时间分组单元测试集
 */
async function runLibraryListReadUiUnitTests(): Promise<void> {
  console.log('=== 1. 时间分组算法与全边界断言（groupStoryWorksByTime）===');
  {
    // 设定基准时间为 2026-09-16 (周三) 15:00:00
    const mockNow = new Date('2026-09-16T15:00:00.000');

    // 1.1 getTimeGroupLabel 各时间段精确判定
    assert.strictEqual(
      getTimeGroupLabel(new Date('2026-09-16T10:00:00.000'), mockNow),
      '今天',
      '当天时间应归入「今天」'
    );
    assert.strictEqual(
      getTimeGroupLabel(new Date('2026-09-15T23:59:59.000'), mockNow),
      '昨天',
      '前一天时间应归入「昨天」'
    );
    assert.strictEqual(
      getTimeGroupLabel(new Date('2026-09-14T10:00:00.000'), mockNow),
      '本周',
      '周一时间应归入「本周」'
    );
    assert.strictEqual(
      getTimeGroupLabel(new Date('2026-09-13T23:59:59.000'), mockNow),
      '更早',
      '早于周一时间应归入「更早」'
    );
    assert.strictEqual(
      getTimeGroupLabel(null, mockNow),
      '更早',
      '空日期防御性归入「更早」'
    );

    // 1.2 active 视图以 createdAt 分组
    const activeItems: LibraryItemViewModel[] = [
      composeLibraryItemViewModel(createMockStory({ id: 1, createdAt: '2026-09-16T14:00:00.000' })),
      composeLibraryItemViewModel(createMockStory({ id: 2, createdAt: '2026-09-15T12:00:00.000' })),
      composeLibraryItemViewModel(createMockStory({ id: 3, createdAt: '2026-09-14T08:00:00.000' })),
      composeLibraryItemViewModel(createMockStory({ id: 4, createdAt: '2026-09-10T08:00:00.000' })),
    ];
    const activeGroups = groupStoryWorksByTime(activeItems, 'active', mockNow);
    assert.strictEqual(activeGroups.length, 4);
    assert.strictEqual(activeGroups[0].label, '今天');
    assert.strictEqual(activeGroups[0].items.length, 1);
    assert.strictEqual(activeGroups[1].label, '昨天');
    assert.strictEqual(activeGroups[2].label, '本周');
    assert.strictEqual(activeGroups[3].label, '更早');

    // 1.3 trash 视图以 deletedAt 分组（且支持 fail-safe 兜底 createdAt）
    const trashItems: LibraryItemViewModel[] = [
      composeLibraryItemViewModel(
        createMockStory({
          id: 10,
          createdAt: '2026-08-01T00:00:00.000',
          deletedAt: '2026-09-16T12:00:00.000',
        })
      ),
      composeLibraryItemViewModel(
        createMockStory({
          id: 11,
          createdAt: '2026-09-15T10:00:00.000',
          deletedAt: null,
        })
      ),
    ];
    const trashGroups = groupStoryWorksByTime(trashItems, 'trash', mockNow);
    assert.strictEqual(trashGroups.length, 2);
    assert.strictEqual(trashGroups[0].label, '今天');
    assert.strictEqual(trashGroups[0].items[0].id, 10);
    assert.strictEqual(trashGroups[1].label, '昨天');
    assert.strictEqual(trashGroups[1].items[0].id, 11);

    console.log('PASS: 1. 时间分组算法与全边界断言通过');
  }

  console.log('=== 2. 核心 Regression：跨 Page 同时间组聚类（只出现一个分组标题）===');
  {
    cleanup();
    const mockNow = new Date('2026-09-16T15:00:00.000');

    // 关键场景设计：
    // Page 1 包含 2 条作品：
    //   item 1: 今天 14:00
    //   item 2: 今天 12:00 (Page 1 结尾仍是今天)
    // Page 2 包含 2 条作品：
    //   item 3: 今天 09:00 (Page 2 开头与 Page 1 末尾同属「今天」!)
    //   item 4: 昨天 18:00
    const page1Items = [
      createMockStory({ id: 1, title: '故事 1', createdAt: '2026-09-16T14:00:00.000' }),
      createMockStory({ id: 2, title: '故事 2', createdAt: '2026-09-16T12:00:00.000' }),
    ];
    const page2Items = [
      createMockStory({ id: 3, title: '故事 3', createdAt: '2026-09-16T09:00:00.000' }),
      createMockStory({ id: 4, title: '故事 4', createdAt: '2026-09-15T18:00:00.000' }),
    ];

    // 模拟数据流水线：打平（flatMap） -> 统一时间分组
    const allFlattened = [...page1Items, ...page2Items];
    const viewModels = composeLibraryItemListViewModel(allFlattened);
    const groups = groupStoryWorksByTime(viewModels, 'active', mockNow);

    // 核心领域断言：跨页打平后，「今天」分组必须恰好只有 1 个，绝不因分页切片产生 2 个「今天」分组
    assert.strictEqual(groups.length, 2, '打平后应只有「今天」与「昨天」共 2 个分组');
    assert.strictEqual(groups[0].label, '今天');
    assert.strictEqual(groups[0].items.length, 3, '「今天」分组内应聚合跨页的 3 条作品');
    assert.deepStrictEqual(
      groups[0].items.map((i: any) => i.id),
      [1, 2, 3]
    );
    assert.strictEqual(groups[1].label, '昨天');
    assert.strictEqual(groups[1].items.length, 1);
    assert.strictEqual(groups[1].items[0].id, 4);

    // DOM 渲染断言：页面渲染时，「今天」的分组标题 DOM 节点恰好只有 1 个
    const { container } = render(
      React.createElement(
        'div',
        null,
        groups.map((group: any) =>
          React.createElement(LibraryTimeGroup, {
            key: group.label,
            group,
            view: 'active',
          })
        )
      )
    );

    const todayTitles = container.querySelectorAll('[data-testid="group-title-今天"]');
    assert.strictEqual(
      todayTitles.length,
      1,
      '分页数据打平后，「今天」分组标题在 DOM 中必须唯一，严禁出现两个「今天」标题'
    );
    assert.strictEqual(todayTitles[0].textContent, '今天');

    const yesterdayTitles = container.querySelectorAll('[data-testid="group-title-昨天"]');
    assert.strictEqual(yesterdayTitles.length, 1);

    // 验证卡片数量与从属关系
    const todayGroupContainer = container.querySelector('[data-testid="library-time-group-今天"]');
    assert.ok(todayGroupContainer);
    assert.strictEqual(
      todayGroupContainer.querySelectorAll('[data-work-id]').length,
      3,
      '今天分组下必须挂载跨 Page 的全部 3 张作品卡片'
    );

    console.log('PASS: 2. 跨 Page 同时间组聚类（分组标题唯一性）断言通过');
  }

  console.log('=== 3. Trash Card 无 Detail Link 铁律渲染断言 ===');
  {
    cleanup();
    const testWork = composeLibraryItemViewModel(
      createMockStory({
        id: 42,
        title: '回收站作品',
        excerpt: '这是一篇在回收站中的作品',
        deletedAt: '2026-09-16T12:00:00.000',
      })
    );

    // 3.1 active 视图下：Card 必须具有指向 /library/[id] 的 Detail Link，且播放按钮为 disabled 占位
    const { container: activeContainer } = render(
      React.createElement(StoryWorkCard, { work: testWork, view: 'active' })
    );
    const activeLink = activeContainer.querySelector('a[href="/library/42"]');
    assert.ok(activeLink, 'active 视图下的卡片必须渲染指向 /library/[id] 的 Link');

    const activePlayBtn = activeContainer.querySelector('[data-testid="story-card-play-btn-42"]') as HTMLButtonElement;
    assert.ok(activePlayBtn, 'active 视图卡片应渲染播放按钮视觉占位');
    assert.strictEqual(activePlayBtn.disabled, true, '播放按钮在 M5 接入前必须 disabled 避免误导');
    cleanup();

    // 3.2 favorites 视图下：Card 必须具有指向 /library/[id] 的 Detail Link
    const { container: favContainer } = render(
      React.createElement(StoryWorkCard, { work: testWork, view: 'favorites' })
    );
    const favLink = favContainer.querySelector('a[href="/library/42"]');
    assert.ok(favLink, 'favorites 视图下的卡片必须渲染指向 /library/[id] 的 Link');
    cleanup();

    // 3.3 trash 视图下：Card 绝不能生成任何 Detail Link！且绝不渲染播放按钮
    const { container: trashContainer } = render(
      React.createElement(StoryWorkCard, { work: testWork, view: 'trash' })
    );
    const trashLink = trashContainer.querySelector('a[href*="/library/42"]');
    assert.strictEqual(
      trashLink,
      null,
      'trash 视图下的卡片绝对严禁渲染任何指向 /library/[id] 的链接！'
    );
    const allLinksInTrash = trashContainer.querySelectorAll('a');
    assert.strictEqual(
      allLinksInTrash.length,
      0,
      'trash 视图卡片内部不得存在任何 <a> 标签链接'
    );

    // 且必须渲染静态标题节点与已移入回收站徽标
    const staticTitle = trashContainer.querySelector('[data-testid="story-card-static-42"]');
    assert.ok(staticTitle, 'trash 视图应降级渲染静态卡片标题');
    assert.strictEqual(staticTitle.textContent, '回收站作品');

    const trashBadge = trashContainer.querySelector('[data-testid="story-card-trash-badge-42"]');
    assert.ok(trashBadge, 'trash 视图必须展示「已移入回收站」标识');
    assert.strictEqual(trashBadge.textContent, '已移入回收站');

    // 播放按钮占位断言：trash 下绝不渲染播放按钮
    const trashPlayBtn = trashContainer.querySelector('[data-testid^="story-card-play-btn-"]');
    assert.strictEqual(trashPlayBtn, null, 'trash 视图卡片不得渲染播放按钮');

    console.log('PASS: 3. Trash Card 无 Detail Link 铁律断言通过');
  }

  console.log('=== 4. 无限滚动三重 Gate 守护与防并发锁断言（InfiniteScrollSentinel）===');
  {
    cleanup();

    // 4.1 正常通过 gate：hasNextPage=true, isFetchingNextPage=false -> 调用 fetchNext
    let fetchCallCount = 0;
    let resolveInFlight: (() => void) | null = null;
    const mockFetch = () => {
      fetchCallCount += 1;
      return new Promise<void>((res) => {
        resolveInFlight = res;
      });
    };

    const { rerender } = render(
      React.createElement(InfiniteScrollSentinel, {
        hasNextPage: true,
        isFetchingNextPage: false,
        onFetchNext: mockFetch,
      })
    );

    // 模拟 IntersectionObserver 视口相交
    assert.ok(activeObserverCallback, 'IntersectionObserver 必须已注册回调');
    act(() => {
      activeObserverCallback!([{ isIntersecting: true } as any], activeObserverInstance);
    });
    assert.strictEqual(fetchCallCount, 1, '满足三重 Gate 时应恰好触发 1 次 fetchNext');

    // 4.2 在途防并发（In-flight Lock）：请求尚未结束时，再次触发相交绝不重复调用
    act(() => {
      activeObserverCallback!([{ isIntersecting: true } as any], activeObserverInstance);
    });
    assert.strictEqual(
      fetchCallCount,
      1,
      '在途请求未 resolve 时，内存锁应拦截并发重复触发'
    );

    // 解除在途
    act(() => {
      resolveInFlight?.();
    });

    // 4.3 Gate 2 拦截：isFetchingNextPage === true 时绝不重复 fetchNext
    rerender(
      React.createElement(InfiniteScrollSentinel, {
        hasNextPage: true,
        isFetchingNextPage: true,
        onFetchNext: mockFetch,
      })
    );
    act(() => {
      activeObserverCallback!([{ isIntersecting: true } as any], activeObserverInstance);
    });
    assert.strictEqual(
      fetchCallCount,
      1,
      'isFetchingNextPage 为 true 时严格禁止触发 fetchNext'
    );

    // 4.4 Gate 1 拦截：hasNextPage === false 时绝不触发
    rerender(
      React.createElement(InfiniteScrollSentinel, {
        hasNextPage: false,
        isFetchingNextPage: false,
        onFetchNext: mockFetch,
      })
    );
    act(() => {
      activeObserverCallback?.([{ isIntersecting: true } as any], activeObserverInstance);
    });
    assert.strictEqual(fetchCallCount, 1, 'hasNextPage 为 false 时禁止触发 fetchNext');

    // 4.5 跨 Query Identity 锁隔离（Key Remount 2 层守卫）
    console.log('--- 4.5 跨 Query Identity 锁隔离回归（Key Remount 两层断言）---');
    {
      cleanup();
      let fetchACallCount = 0;
      let resolveA: (() => void) | null = null;
      const mockFetchA = () => {
        fetchACallCount += 1;
        return new Promise<void>((res) => {
          resolveA = res;
        });
      };

      let fetchBCallCount = 0;
      let resolveB: (() => void) | null = null;
      const mockFetchB = () => {
        fetchBCallCount += 1;
        return new Promise<void>((res) => {
          resolveB = res;
        });
      };

      // 模拟 LibraryPage 中 <InfiniteScrollSentinel key={JSON.stringify([view, q ?? null])} ... />
      const TestContainer = ({
        view,
        q,
        onFetch,
      }: {
        view: string;
        q?: string | null;
        onFetch: () => Promise<void>;
      }) =>
        React.createElement(InfiniteScrollSentinel, {
          key: JSON.stringify([view, q ?? null]),
          hasNextPage: true,
          isFetchingNextPage: false,
          onFetchNext: onFetch,
        });

      // 阶段 1：在 active 视图下挂载并触发相交
      const { rerender: rerenderContainer } = render(
        React.createElement(TestContainer, {
          view: 'active',
          q: null,
          onFetch: mockFetchA,
        })
      );

      assert.ok(activeObserverCallback, 'active Sentinel 必须已挂载 observer');
      act(() => {
        activeObserverCallback!([{ isIntersecting: true } as any], activeObserverInstance);
      });
      assert.strictEqual(fetchACallCount, 1, 'active 视图首次触发相交，fetchA 必须调用 1 次');
      // 注意：此时 resolveA 未调用，请求 A 在途（A promise 保持 unresolved）

      // 阶段 2 (Layer a)：用户切换视图为 favorites（新 query identity），A 仍未返回！
      // 此时 key 发生变更，React 触发 unmount 旧实例 + mount 新实例
      rerenderContainer(
        React.createElement(TestContainer, {
          view: 'favorites',
          q: null,
          onFetch: mockFetchB,
        })
      );

      // 新实例相交触发
      assert.ok(activeObserverCallback, 'favorites Sentinel 必须已挂载新 observer');
      act(() => {
        activeObserverCallback!([{ isIntersecting: true } as any], activeObserverInstance);
      });
      assert.strictEqual(
        fetchBCallCount,
        1,
        'Layer a: 虽旧请求 A 仍处于挂起未返回状态，但因 key remount 隔离，新视图 favorites 绝不受旧锁阻断，fetchB 必须成功调用 1 次'
      );

      // 阶段 3 (Layer b 加强层)：B 仍处于在途挂起未返回状态，此时旧请求 A 终于 settle（resolve A）
      act(() => {
        resolveA?.();
      });

      // 再次触发相交：验证旧请求 A 的 settle（A.finally）绝不会误解开当前新 query B 的并发锁！
      act(() => {
        activeObserverCallback!([{ isIntersecting: true } as any], activeObserverInstance);
      });
      assert.strictEqual(
        fetchBCallCount,
        1,
        'Layer b: 旧请求 A resolve 之后，由于旧闭包只操作已销毁旧实例的 ref，新实例 B 的在途锁绝不被误释放，fetchB 仍只能为 1 次'
      );

      // 解除 B
      act(() => {
        resolveB?.();
      });

      console.log('PASS: 4.5 跨 Query Identity 锁隔离（Key Remount 两层断言）通过');
    }

    console.log('PASS: 4. 无限滚动三重 Gate 守护与防并发断言通过');
  }

  console.log('=== 5. 全量 8 类 UI 状态渲染断言 ===');
  {
    cleanup();

    // 5.1 Initial Loading 状态
    const { container: loadingContainer } = render(
      React.createElement(LibraryLoadingSkeleton, { count: 6 })
    );
    assert.ok(
      loadingContainer.querySelector('[data-testid="library-loading-skeleton"]'),
      '初始加载应渲染骨架屏容器'
    );
    assert.strictEqual(
      loadingContainer.querySelectorAll('[data-testid^="skeleton-card-"]').length,
      6,
      '骨架屏应包含 6 张卡片'
    );
    cleanup();

    // 5.2 Initial Error + Retry 状态
    let retryCalled = false;
    const { container: errorContainer } = render(
      React.createElement(LibraryErrorState, {
        error: new Error('网络请求超时'),
        onRetry: () => {
          retryCalled = true;
        },
      })
    );
    assert.ok(
      errorContainer.querySelector('[data-testid="library-initial-error"]'),
      '应渲染错误状态容器'
    );
    const retryBtn = errorContainer.querySelector(
      '[data-testid="library-retry-btn"]'
    ) as HTMLButtonElement;
    assert.ok(retryBtn);
    fireEvent.click(retryBtn);
    assert.strictEqual(retryCalled, true, '点击重试按钮必须触发 onRetry 回调');
    cleanup();

    // 5.3 Active Empty 状态
    const { container: activeEmptyContainer } = render(
      React.createElement(LibraryEmptyState, { view: 'active' })
    );
    assert.ok(
      activeEmptyContainer.querySelector('[data-testid="library-empty-active"]'),
      '全部视图空状态容器存在'
    );
    assert.ok(
      activeEmptyContainer.textContent?.includes('还没有故事'),
      '展示文案：还没有故事'
    );
    const createLink = activeEmptyContainer.querySelector(
      '[data-testid="empty-cta-create"]'
    ) as HTMLAnchorElement;
    assert.ok(createLink);
    assert.strictEqual(createLink.getAttribute('href'), '/chat');
    cleanup();

    // 5.4 Favorites Empty 状态
    const { container: favEmptyContainer } = render(
      React.createElement(LibraryEmptyState, { view: 'favorites' })
    );
    assert.ok(
      favEmptyContainer.querySelector('[data-testid="library-empty-favorites"]'),
      '收藏视图空状态容器存在'
    );
    assert.ok(
      favEmptyContainer.textContent?.includes('还没有收藏的故事'),
      '展示文案：还没有收藏的故事'
    );
    cleanup();

    // 5.5 Trash Empty 状态
    const { container: trashEmptyContainer } = render(
      React.createElement(LibraryEmptyState, { view: 'trash' })
    );
    assert.ok(
      trashEmptyContainer.querySelector('[data-testid="library-empty-trash"]'),
      '回收站空状态容器存在'
    );
    assert.ok(
      trashEmptyContainer.textContent?.includes('回收站为空'),
      '展示文案：回收站为空'
    );
    assert.ok(
      trashEmptyContainer.textContent?.includes('30 天后永久删除'),
      '展示文案：30 天后永久删除提示'
    );
    cleanup();

    // 5.6 Search Empty 状态
    let clearSearchCalled = false;
    const { container: searchEmptyContainer } = render(
      React.createElement(LibraryEmptyState, {
        view: 'active',
        query: '月球探险',
        onClearSearch: () => {
          clearSearchCalled = true;
        },
      })
    );
    assert.ok(
      searchEmptyContainer.querySelector('[data-testid="library-empty-search"]'),
      '搜索空状态容器存在'
    );
    assert.ok(
      searchEmptyContainer.textContent?.includes('没有找到匹配“月球探险”的故事'),
      '展示文案包含搜索词'
    );
    const clearBtn = searchEmptyContainer.querySelector(
      '[data-testid="clear-search-btn"]'
    ) as HTMLButtonElement;
    assert.ok(clearBtn);
    fireEvent.click(clearBtn);
    assert.strictEqual(clearSearchCalled, true, '点击清除搜索按钮触发回调');
    cleanup();

    // 5.7 Next-page Loading 状态
    const { container: nextLoadingContainer } = render(
      React.createElement(InfiniteScrollSentinel, {
        hasNextPage: true,
        isFetchingNextPage: true,
        onFetchNext: () => {},
      })
    );
    assert.ok(
      nextLoadingContainer.querySelector('[data-testid="next-page-loading"]'),
      '正在拉取下一页时展示 next-page-loading 指示器'
    );
    assert.ok(
      nextLoadingContainer.textContent?.includes('正在加载更多故事...'),
      '包含加载文案'
    );
    cleanup();

    // 5.8 Terminal No-more 状态
    const testTerminalEl = React.createElement(
      'div',
      { 'data-testid': 'terminal-no-more' },
      '— 没有更多了 —'
    );
    const { container: terminalContainer } = render(testTerminalEl);
    const noMoreNode = terminalContainer.querySelector('[data-testid="terminal-no-more"]');
    assert.ok(noMoreNode, '触底终态应展示 terminal-no-more 标记');
    assert.strictEqual(noMoreNode.textContent, '— 没有更多了 —');
    cleanup();

    console.log('PASS: 5. 全量 8 类 UI 状态渲染断言全部通过');
  }

  console.log('=== 6. Toolbar 交互与三视图切换断言（LibraryToolbar）===');
  {
    cleanup();
    let selectedView = 'active';
    let draftQuery = '小狐狸';
    let cleared = false;

    const { container } = render(
      React.createElement(LibraryToolbar, {
        view: selectedView as any,
        draftQ: draftQuery,
        onViewChange: (v: string) => {
          selectedView = v;
        },
        onDraftQChange: (q: string) => {
          draftQuery = q;
        },
        onClearSearch: () => {
          cleared = true;
          draftQuery = '';
        },
      })
    );

    // 验证 Tab 初始高亮与文本
    const activeTab = container.querySelector('[data-testid="view-tab-active"]');
    assert.ok(activeTab);
    assert.strictEqual(activeTab.getAttribute('aria-selected'), 'true');

    // 切换到 favorites
    const favTab = container.querySelector(
      '[data-testid="view-tab-favorites"]'
    ) as HTMLButtonElement;
    fireEvent.click(favTab);
    assert.strictEqual(selectedView, 'favorites', '点击收藏 Tab 应触发 onViewChange');

    // 切换到 trash
    const trashTab = container.querySelector(
      '[data-testid="view-tab-trash"]'
    ) as HTMLButtonElement;
    fireEvent.click(trashTab);
    assert.strictEqual(selectedView, 'trash', '点击回收站 Tab 应触发 onViewChange');

    // 清空搜索按钮
    const clearBtn = container.querySelector(
      '[data-testid="library-search-clear-btn"]'
    ) as HTMLButtonElement;
    assert.ok(clearBtn);
    fireEvent.click(clearBtn);
    assert.strictEqual(cleared, true, '点击输入框清除按钮应触发 onClearSearch');

    console.log('PASS: 6. Toolbar 交互与三视图切换断言通过');
  }

  console.log('=== 7. 静态纯只读与架构隔离守卫（No Mutations / No Client Leak）===');
  {
    const libraryIndexPath = path.join(process.cwd(), 'app/(main)/library/index.tsx');
    const libraryIndexCode = fs.readFileSync(libraryIndexPath, 'utf-8');

    // 7.1 严禁在 M3-04 中直接调用任何生命周期 Mutation
    const forbiddenMutationPatterns = [
      'setStoryWorkFavorite',
      'moveStoryWorkToTrash',
      'restoreStoryWork',
      'deleteStoryWorkPermanently',
      'renameStoryWork',
      'useMutation',
    ];
    for (const pattern of forbiddenMutationPatterns) {
      assert.strictEqual(
        libraryIndexCode.includes(pattern),
        false,
        `M3-04 只做读取 UI，严禁提前引入 mutation 行为: ${pattern}`
      );
    }

    // 7.2 严禁新增或使用 libraryStore
    assert.strictEqual(
      libraryIndexCode.includes('libraryStore'),
      false,
      '严禁新增或引用 libraryStore，远端状态必须由 TanStack Query 托管'
    );

    // 7.3 严禁在 UI 页面层直接调用底层 libraryClient 或 prisma
    assert.strictEqual(
      libraryIndexCode.includes('libraryClient.'),
      false,
      'UI 页面层严禁直接调用 libraryClient，必须走 Query 钩子'
    );
    assert.strictEqual(
      libraryIndexCode.includes('@prisma/client'),
      false,
      'UI 页面层严禁导入 Prisma'
    );

    // 7.4 静态守卫：InfiniteScrollSentinel 必须挂载 key={JSON.stringify([view, q ?? null])}
    assert.ok(
      libraryIndexCode.includes('key={JSON.stringify([view, q ?? null])}'),
      'LibraryPage 必须显式声明 key={JSON.stringify([view, q ?? null])} 保障 Sentinel 跨 query identity 锁隔离'
    );

    console.log('PASS: 7. 静态纯只读与架构隔离守卫断言通过');
  }

  console.log('ALL LIBRARY LIST READ UI UNIT TESTS PASSED SUCCESSFULLY');
}

runLibraryListReadUiUnitTests().catch((err) => {
  console.error('LIBRARY LIST READ UI UNIT TEST FAILED:', err);
  process.exit(1);
});
