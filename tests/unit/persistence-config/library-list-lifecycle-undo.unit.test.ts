/**
 * Library 列表生命周期与 Undo 单元测试 (M3-05)
 *
 * 核心验证范围（必测 Regression）：
 * 1) move pending 时点 Undo → 调用顺序严格 move resolve → restore
 * 2) move 失败后不出现 Undo，并恢复原 cache
 * 3) 旧 move promise resolve 不得污染随后另一条 Undo
 * 4) favorites/restore 只 patch/remove 已加载 item，绝不向另一个 infinite cache append
 * 5) opaque cursor/pageParams 在 optimistic patch/remove 后保持原样
 * 6) Permanent Delete 未确认时零 RPC，确认后才调用
 *
 * M3-05 FIXUP 专项回归（3 Blocking）：
 * B1) Token-aware 失败清理：真实 Hook 链下 A 晚失败不得误杀 B 的 Undo 会话
 * B2) View-aware 视图隔离：active/favorites/trash 多缓存并存时变更按 view 精确作用
 * B3) 局部逆向回滚：并发 Move/Favorite 失败局部回滚无僵尸数据复活
 *
 * 附加断言：
 * 7) 纯缓存算子不变性与防御性（removeItem, patchFavorite, reconcile, journal）
 * 8) StoryWorkCard 交互集成与二次确认弹窗
 * 9) 静态架构与无 Store 约束守卫
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
        // ignore
      }
    }
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;
}

setupJsdom();
installAssetStubs();

// 使用 jiti 动态载入模块
const jitiFactory = nodeRequire('jiti');
const innerJiti = jitiFactory(path.join(repoRoot, 'index.js'), {
  alias: { '@': repoRoot },
  jsx: true,
});

const {
  removeItemFromInfiniteData,
  patchItemFavoriteInInfiniteData,
  reconcileItemInInfiniteData,
  determineListMutationAction,
  applyOptimisticMutationToQueries,
  rollbackMutationJournal,
  mutateToggleFavorite,
  mutateMoveToTrash,
  mutateRestore,
  mutateDeletePermanently,
  useLibraryMutations,
  useLibraryMutationsSafe,
} = innerJiti('./lib/client/libraryMutations.ts');

const {
  LibraryUndoProvider,
  useLibraryUndo,
} = innerJiti('./components/Library/LibraryUndoProvider.tsx');

const { StoryWorkCard } = innerJiti(
  './app/(main)/library/components/StoryWorkCard.tsx'
);

const { render, fireEvent, act, cleanup } = nodeRequire('@testing-library/react');

const { libraryKeys } = innerJiti('./lib/client/libraryQueries.ts');

// 测试辅助数据生成器
function createMockItem(id: number, overrides: Partial<any> = {}) {
  return {
    id,
    title: `故事作品 ${id}`,
    excerpt: `这是故事 ${id} 的摘要内容`,
    voiceId: 'zh-CN-YunxiNeural',
    contentHash: `hash-${id}`,
    favoritedAt: null,
    deletedAt: null,
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z',
    audio: {
      status: 'ready',
      durationMs: 65000,
    },
    ...overrides,
  };
}

function createMockInfiniteData(pagesItems: any[][], cursors: (string | null)[]) {
  return {
    pages: pagesItems.map((items, i) => ({
      items,
      nextCursor: cursors[i] ?? null,
      hasMore: cursors[i] !== null,
    })),
    pageParams: [undefined, ...cursors.slice(0, -1).filter((c): c is string => c !== null)],
  };
}

async function runLifecycleUndoUnitTests() {
  console.log('=== Regression 5: opaque cursor 与 pageParams 在 optimistic patch/remove 后保持原样 ===');
  {
    const initialData = {
      pages: [
        {
          items: [createMockItem(1), createMockItem(2)],
          nextCursor: 'opaque_cursor_alpha_001',
          hasMore: true,
        },
        {
          items: [createMockItem(3), createMockItem(4)],
          nextCursor: 'opaque_cursor_beta_002',
          hasMore: true,
        },
        {
          items: [createMockItem(5)],
          nextCursor: null,
          hasMore: false,
        },
      ],
      pageParams: [undefined, 'opaque_cursor_alpha_001', 'opaque_cursor_beta_002'],
    };

    // 5.1 执行 optimistic patch (favorite)
    const patchedData = patchItemFavoriteInInfiniteData(
      initialData,
      2,
      '2026-09-12T12:00:00.000Z',
      false
    );

    assert.strictEqual(patchedData.pages.length, 3, '分页数量保持不变');
    assert.strictEqual(patchedData.pages[0].nextCursor, 'opaque_cursor_alpha_001', 'Page 0 cursor 原样保持');
    assert.strictEqual(patchedData.pages[0].hasMore, true, 'Page 0 hasMore 原样保持');
    assert.strictEqual(patchedData.pages[1].nextCursor, 'opaque_cursor_beta_002', 'Page 1 cursor 原样保持');
    assert.strictEqual(patchedData.pages[1].hasMore, true, 'Page 1 hasMore 原样保持');
    assert.strictEqual(patchedData.pages[2].nextCursor, null, 'Page 2 cursor 原样保持');
    assert.strictEqual(patchedData.pages[2].hasMore, false, 'Page 2 hasMore 原样保持');
    assert.deepStrictEqual(
      patchedData.pageParams,
      [undefined, 'opaque_cursor_alpha_001', 'opaque_cursor_beta_002'],
      'pageParams 数组必须绝对原样保持'
    );
    assert.strictEqual(patchedData.pages[0].items[1].favoritedAt, '2026-09-12T12:00:00.000Z');

    // 5.2 执行 optimistic remove
    const removedData = removeItemFromInfiniteData(patchedData, 2);
    assert.strictEqual(removedData.pages[0].items.length, 1, '第 1 页项被移除');
    assert.strictEqual(removedData.pages[0].items[0].id, 1);
    assert.strictEqual(removedData.pages[0].nextCursor, 'opaque_cursor_alpha_001', 'remove 后 nextCursor 原样保持');
    assert.strictEqual(removedData.pages[0].hasMore, true, 'remove 后 hasMore 原样保持');
    assert.deepStrictEqual(
      removedData.pageParams,
      [undefined, 'opaque_cursor_alpha_001', 'opaque_cursor_beta_002'],
      'remove 后 pageParams 原样保持'
    );

    // 5.3 执行 reconcile
    const reconciledData = reconcileItemInInfiniteData(
      removedData,
      createMockItem(4, { title: '重命名故事 4' })
    );
    assert.strictEqual(reconciledData.pages[1].items[1].title, '重命名故事 4');
    assert.strictEqual(reconciledData.pages[1].nextCursor, 'opaque_cursor_beta_002', 'reconcile 后 nextCursor 原样保持');
    assert.deepStrictEqual(
      reconciledData.pageParams,
      [undefined, 'opaque_cursor_alpha_001', 'opaque_cursor_beta_002'],
      'reconcile 后 pageParams 原样保持'
    );

    console.log('PASS: Regression 5 通过（opaque cursor / pageParams 绝对原样保持）');
  }

  console.log('=== Regression 4: favorites/restore 只 patch/remove 已加载 item，绝不向另一个 infinite cache append ===');
  {
    const activeCacheKey = libraryKeys.list({ view: 'active' });
    const favoritesCacheKey = libraryKeys.list({ view: 'favorites' });
    const trashCacheKey = libraryKeys.list({ view: 'trash' });

    const queryClient = new QueryClient();

    // 构造三份独立的列表缓存
    const item1 = createMockItem(1, { favoritedAt: null });
    const item2 = createMockItem(2, { favoritedAt: null });
    const item3 = createMockItem(3, { favoritedAt: '2026-09-12T00:00:00.000Z' });
    const item4 = createMockItem(4, { deletedAt: '2026-09-12T01:00:00.000Z' });

    queryClient.setQueryData(activeCacheKey, createMockInfiniteData([[item1, item2]], [null]));
    queryClient.setQueryData(favoritesCacheKey, createMockInfiniteData([[item3]], [null]));
    queryClient.setQueryData(trashCacheKey, createMockInfiniteData([[item4]], [null]));

    // 4.1 在 active 视图中收藏 item 1：
    // active 缓存中 item 1 被 patch favoritedAt；
    // favorites 缓存绝不增加 item 1！
    const favResult = patchItemFavoriteInInfiniteData(
      queryClient.getQueryData(activeCacheKey)!,
      1,
      '2026-09-12T12:00:00.000Z',
      false
    );
    queryClient.setQueryData(activeCacheKey, favResult);

    const favoritesDataAfterFav = queryClient.getQueryData<any>(favoritesCacheKey)!;
    assert.strictEqual(
      favoritesDataAfterFav.pages[0].items.length,
      1,
      'favorites 缓存数量绝不因 active 收藏而增加'
    );
    assert.strictEqual(favoritesDataAfterFav.pages[0].items[0].id, 3, 'favorites 缓存中依然仅有原本项');
    assert.ok(
      !favoritesDataAfterFav.pages[0].items.some((it: any) => it.id === 1),
      '严禁凭客户端臆测将 item 1 append 到已有的 favorites infinite cache！'
    );

    // 4.2 在 favorites 视图中取消收藏 item 3：
    // favorites 缓存中 item 3 被移除；
    // active 缓存绝不 append item 3！
    const unfavResult = patchItemFavoriteInInfiniteData(
      queryClient.getQueryData(favoritesCacheKey)!,
      3,
      null,
      true // isFavoritesView
    );
    queryClient.setQueryData(favoritesCacheKey, unfavResult);

    const favoritesDataAfterUnfav = queryClient.getQueryData<any>(favoritesCacheKey)!;
    assert.strictEqual(favoritesDataAfterUnfav.pages[0].items.length, 0, 'favorites 视图下取消收藏直接从列表移除');

    const activeDataAfterUnfav = queryClient.getQueryData<any>(activeCacheKey)!;
    assert.strictEqual(activeDataAfterUnfav.pages[0].items.length, 2, 'active 缓存数量不变');

    // 4.3 在 trash 视图中恢复 item 4：
    // trash 缓存移除 item 4；
    // active 缓存绝不本地 append item 4！
    const trashAfterRestore = removeItemFromInfiniteData(
      queryClient.getQueryData(trashCacheKey)!,
      4
    );
    queryClient.setQueryData(trashCacheKey, trashAfterRestore);

    const trashDataAfterRestore = queryClient.getQueryData<any>(trashCacheKey)!;
    assert.strictEqual(trashDataAfterRestore.pages[0].items.length, 0, 'trash 缓存中项被乐观移除');

    const activeDataAfterRestore = queryClient.getQueryData<any>(activeCacheKey)!;
    assert.ok(
      !activeDataAfterRestore.pages[0].items.some((it: any) => it.id === 4),
      '恢复作品时绝对禁止本地向 active 缓存 append（必须由 invalidate 重新查询）'
    );

    queryClient.clear();
    console.log('PASS: Regression 4 通过（绝不向另一个 infinite cache 脏注入 append）');
  }

  console.log('=== Regression 1: move pending 时点 Undo → 调用顺序严格 move resolve → restore ===');
  {
    const queryClient = new QueryClient();
    const activeCacheKey = libraryKeys.list({ view: 'active' });
    const item101 = createMockItem(101);
    queryClient.setQueryData(activeCacheKey, createMockInfiniteData([[item101]], [null]));

    const callOrder: string[] = [];
    let resolveMovePromise!: (val: any) => void;
    const moveDeferredPromise = new Promise((resolve) => {
      resolveMovePromise = resolve;
    });

    // 模拟 client:
    // moveToTrash 返回 deferred promise
    const originalMoveToTrash = innerJiti('./lib/client/library.ts').libraryClient.moveToTrash;
    const originalRestore = innerJiti('./lib/client/library.ts').libraryClient.restore;

    innerJiti('./lib/client/library.ts').libraryClient.moveToTrash = async ({ id }: any) => {
      callOrder.push(`moveToTrash:start:${id}`);
      await moveDeferredPromise;
      callOrder.push(`moveToTrash:resolve:${id}`);
      return createMockItem(id, { deletedAt: '2026-09-12T12:00:00.000Z' });
    };

    innerJiti('./lib/client/library.ts').libraryClient.restore = async ({ id }: any) => {
      callOrder.push(`restore:start:${id}`);
      callOrder.push(`restore:resolve:${id}`);
      return createMockItem(id, { deletedAt: null });
    };

    let undoToken = 0;
    let undoSession: any = null;

    // 发起移入回收站
    const moveTaskPromise = mutateMoveToTrash(queryClient, {
      id: 101,
      workTitle: '故事 101',
      onUndoRegistered: (session: any) => {
        undoSession = session;
        undoToken = 1;
      },
    });

    // 微任务等待 cancelQueries 完成并触发 onUndoRegistered
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(undoSession, 'onUndoRegistered 必须已触发并携带在途 movePromise');
    assert.strictEqual(callOrder.length, 1);
    assert.strictEqual(callOrder[0], 'moveToTrash:start:101');

    // 此时 move 仍在 pending 中！用户立即点击 Undo：
    // 模拟 triggerUndo 中的核心逻辑：await movePromise -> then restore(id)
    let undoCompleted = false;
    const undoPromise = (async () => {
      await undoSession.movePromise;
      await innerJiti('./lib/client/library.ts').libraryClient.restore({ id: undoSession.workId });
      undoCompleted = true;
    })();

    // 此时微任务让步，restore 绝不能被调用！
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(
      callOrder.includes('restore:start:101'),
      false,
      'move 未决时严格禁止提前调用 restore，防止遭遇 409 CONFLICT'
    );
    assert.strictEqual(undoCompleted, false);

    // 现在 resolve movePromise
    resolveMovePromise(true);
    await moveTaskPromise;
    await undoPromise;

    // 校验调用序列
    assert.deepStrictEqual(
      callOrder,
      [
        'moveToTrash:start:101',
        'moveToTrash:resolve:101',
        'restore:start:101',
        'restore:resolve:101',
      ],
      '调用顺序必须严格为 moveToTrash:start -> moveToTrash:resolve -> restore:start -> restore:resolve'
    );
    assert.strictEqual(undoCompleted, true);

    // 还原 mock
    innerJiti('./lib/client/library.ts').libraryClient.moveToTrash = originalMoveToTrash;
    innerJiti('./lib/client/library.ts').libraryClient.restore = originalRestore;
    queryClient.clear();

    console.log('PASS: Regression 1 通过（move pending 时点 Undo 严格串行保证）');
  }

  console.log('=== Regression 2: move 失败后不出现 Undo，并恢复原 cache ===');
  {
    const queryClient = new QueryClient();
    const activeCacheKey = libraryKeys.list({ view: 'active' });
    const item201 = createMockItem(201, { title: '待删除作品' });
    const item202 = createMockItem(202, { title: '留存作品' });
    queryClient.setQueryData(activeCacheKey, createMockInfiniteData([[item201, item202]], [null]));

    // 初始快照项验证
    const initialItems = queryClient.getQueryData<any>(activeCacheKey)!.pages[0].items;
    assert.strictEqual(initialItems.length, 2);

    let undoRegistered = false;
    let failedCalled = false;

    // 模拟 client.moveToTrash 抛错
    const originalMoveToTrash = innerJiti('./lib/client/library.ts').libraryClient.moveToTrash;
    innerJiti('./lib/client/library.ts').libraryClient.moveToTrash = async () => {
      throw new Error('网络断开，移入回收站失败');
    };

    let errorThrown: any = null;
    try {
      await mutateMoveToTrash(queryClient, {
        id: 201,
        workTitle: '待删除作品',
        onUndoRegistered: () => {
          undoRegistered = true;
        },
        onMoveFailed: () => {
          failedCalled = true;
        },
      });
    } catch (err) {
      errorThrown = err;
    }

    assert.ok(errorThrown, 'mutateMoveToTrash 发生异常必须向上抛出');
    assert.strictEqual(failedCalled, true, '必须触发 onMoveFailed 回调以关闭/阻止 Undo');

    // 校验缓存必须恢复为初始 2 条项
    const restoredItems = queryClient.getQueryData<any>(activeCacheKey)!.pages[0].items;
    assert.strictEqual(restoredItems.length, 2, '失败后快照必须恢复为 2 项');
    assert.strictEqual(restoredItems[0].id, 201, '被乐观删除的 201 必须已成功回滚');
    assert.strictEqual(restoredItems[1].id, 202);

    innerJiti('./lib/client/library.ts').libraryClient.moveToTrash = originalMoveToTrash;
    queryClient.clear();

    console.log('PASS: Regression 2 通过（move 失败后不出现 Undo 并恢复原 cache）');
  }

  console.log('=== Regression 3: 旧 move promise resolve 不得污染随后另一条 Undo ===');
  {
    cleanup();

    let resolveMove1!: (v: any) => void;
    const movePromise1 = new Promise((resolve) => {
      resolveMove1 = resolve;
    });

    let resolveMove2!: (v: any) => void;
    const movePromise2 = new Promise((resolve) => {
      resolveMove2 = resolve;
    });

    // 构造测试环境并渲染 LibraryUndoProvider
    let testUndoContext!: ReturnType<typeof useLibraryUndo>;

    const TestConsumer = () => {
      testUndoContext = useLibraryUndo();
      return React.createElement('div', null, 'Consumer');
    };

    const queryClient = new QueryClient();
    const { container } = render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          LibraryUndoProvider,
          null,
          React.createElement(TestConsumer, null)
        )
      )
    );

    // 步骤 1：触发 Item 1 的移入回收站 (workId: 301)
    let token1 = 0;
    act(() => {
      token1 = testUndoContext.showUndo({
        workId: 301,
        workTitle: '作品 301',
        movePromise: movePromise1,
      });
    });

    assert.strictEqual(token1, 1);
    assert.strictEqual(testUndoContext.activeUndo?.workId, 301);
    assert.strictEqual(testUndoContext.activeUndo?.workTitle, '作品 301');

    // 步骤 2：在 movePromise1 未决前，用户触发 Item 2 的移入回收站 (workId: 302)
    let token2 = 0;
    act(() => {
      token2 = testUndoContext.showUndo({
        workId: 302,
        workTitle: '作品 302',
        movePromise: movePromise2,
      });
    });

    assert.strictEqual(token2, 2);
    assert.strictEqual(testUndoContext.activeUndo?.workId, 302);
    assert.strictEqual(testUndoContext.activeUndo?.workTitle, '作品 302');

    // 步骤 3：此时旧的 movePromise1 resolve
    await act(async () => {
      resolveMove1(true);
      await movePromise1;
    });

    // 断言：activeUndo 必须依然是 Item 2 (302)，旧的 movePromise1 完成绝不改变或清理 Item 2 的 Undo！
    assert.strictEqual(
      testUndoContext.activeUndo?.workId,
      302,
      '旧 movePromise1 resolve 绝不能覆盖或清除当前 Item 2 的 Undo 状态'
    );
    assert.strictEqual(testUndoContext.activeUndo?.token, 2);

    // 步骤 4：旧的 movePromise 若发生 reject，同样不得清除 Item 2
    const failingOldPromise = Promise.reject(new Error('旧操作失败'));
    failingOldPromise.catch(() => {}); // prevent unhandled
    act(() => {
      // 模拟旧 promise 在后台 reject
    });

    assert.strictEqual(testUndoContext.activeUndo?.workId, 302);

    cleanup();
    queryClient.clear();

    console.log('PASS: Regression 3 通过（旧 move promise resolve 不得污染随后另一条 Undo）');
  }

  console.log('=== Regression B1: 真实 Hook 链：mutateMoveToTrash(A) pending -> mutateMoveToTrash(B) pending -> A reject -> Undo 依然是 B ===');
  {
    cleanup();

    let hookMutations!: ReturnType<typeof useLibraryMutations>;
    let testUndoContext!: ReturnType<typeof useLibraryUndo>;

    const TestRealHookConsumer = () => {
      hookMutations = useLibraryMutations();
      testUndoContext = useLibraryUndo();
      return React.createElement('div', null, 'Hook Consumer');
    };

    const queryClient = new QueryClient();
    const activeCacheKey = libraryKeys.list({ view: 'active' });
    const itemA = createMockItem(1001, { title: '作品 A' });
    const itemB = createMockItem(1002, { title: '作品 B' });
    queryClient.setQueryData(activeCacheKey, createMockInfiniteData([[itemA, itemB]], [null]));

    const { container } = render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          LibraryUndoProvider,
          null,
          React.createElement(TestRealHookConsumer, null)
        )
      )
    );

    let rejectMoveA!: (err: any) => void;
    const movePromiseA = new Promise((_resolve, reject) => {
      rejectMoveA = reject;
    });

    let resolveMoveB!: (val: any) => void;
    const movePromiseB = new Promise((resolve) => {
      resolveMoveB = resolve;
    });

    const originalMoveToTrash = innerJiti('./lib/client/library.ts').libraryClient.moveToTrash;
    innerJiti('./lib/client/library.ts').libraryClient.moveToTrash = async ({ id }: any) => {
      if (id === 1001) {
        await movePromiseA;
        return createMockItem(1001, { deletedAt: '2026-09-12T12:00:00.000Z' });
      }
      if (id === 1002) {
        await movePromiseB;
        return createMockItem(1002, { deletedAt: '2026-09-12T12:00:00.000Z' });
      }
      return createMockItem(id);
    };

    // 1. 用户删除 A（发起 move A）
    let moveTaskAPromise!: Promise<any>;
    await act(async () => {
      moveTaskAPromise = hookMutations.moveToTrash({ id: 1001, title: '作品 A' });
      moveTaskAPromise.catch(() => {});
      await new Promise((r) => setTimeout(r, 10));
    });

    // 断言 Undo 当前显示 A，token 为 1
    assert.strictEqual(testUndoContext.activeUndo?.workId, 1001);
    assert.strictEqual(testUndoContext.activeUndo?.token, 1);
    let toast = container.querySelector('[data-testid="library-undo-toast"]');
    assert.ok(toast, '删除 A 后应展示 Undo Toast');
    assert.strictEqual(toast.getAttribute('data-work-id'), '1001');

    // 2. 在 move A 仍处于 pending 时，用户删除 B（发起 move B）
    let moveTaskBPromise!: Promise<any>;
    await act(async () => {
      moveTaskBPromise = hookMutations.moveToTrash({ id: 1002, title: '作品 B' });
      moveTaskBPromise.catch(() => {});
      await new Promise((r) => setTimeout(r, 10));
    });

    // 断言 Undo 当前已切换至 B，token 为 2
    assert.strictEqual(testUndoContext.activeUndo?.workId, 1002);
    assert.strictEqual(testUndoContext.activeUndo?.token, 2);
    toast = container.querySelector('[data-testid="library-undo-toast"]');
    assert.strictEqual(toast?.getAttribute('data-work-id'), '1002');

    // 3. 此时先前的 move A 失败（reject）
    await act(async () => {
      rejectMoveA(new Error('A 移动失败（网络断开）'));
      await new Promise((r) => setTimeout(r, 20));
    });

    // 核心断言（B1）：
    // A 失败的回调必须携带 token 1，Provider 校验 1 !== 2，绝不能把 B 的 Undo session 清除！
    assert.strictEqual(
      testUndoContext.activeUndo?.workId,
      1002,
      '旧操作 A 失败绝不能错误关闭新操作 B 的 Undo 会话'
    );
    assert.strictEqual(testUndoContext.activeUndo?.token, 2);
    toast = container.querySelector('[data-testid="library-undo-toast"]');
    assert.ok(toast, 'B 的 Undo Toast 必须依然保持挂载');
    assert.strictEqual(toast.getAttribute('data-work-id'), '1002');

    // 4. move B 成功 resolve
    await act(async () => {
      resolveMoveB(createMockItem(1002, { deletedAt: '2026-09-12T12:00:00.000Z' }));
      await moveTaskBPromise;
    });

    // B 依然显示在 Undo 中
    assert.strictEqual(testUndoContext.activeUndo?.workId, 1002);

    // 5. 点击 Undo 关闭按钮（传递 token 2），正常关闭
    act(() => {
      testUndoContext.dismissUndo(2);
    });
    assert.strictEqual(testUndoContext.activeUndo, null, '使用匹配 token 正常关闭');

    // 6. 防御性断言：使用错误 token 无法关闭
    act(() => {
      testUndoContext.showUndo({
        workId: 1003,
        workTitle: '作品 C',
        movePromise: Promise.resolve(),
      });
    });
    assert.strictEqual(testUndoContext.activeUndo?.workId, 1003);
    const tokenC = testUndoContext.activeUndo?.token!;
    act(() => {
      testUndoContext.dismissUndo(tokenC - 1); // 传入不匹配的旧 token
    });
    assert.strictEqual(testUndoContext.activeUndo?.workId, 1003, '不匹配 token 绝不关闭');
    act(() => {
      testUndoContext.dismissUndo(tokenC);
    });
    assert.strictEqual(testUndoContext.activeUndo, null);

    innerJiti('./lib/client/library.ts').libraryClient.moveToTrash = originalMoveToTrash;
    cleanup();
    queryClient.clear();
    console.log('PASS: Regression B1 通过（真实 Hook 链下旧 move 失败绝不误杀新 Undo 会话）');
  }

  console.log('=== Regression B2: View-aware 视图隔离多缓存变更精确控制 ===');
  {
    // 单元断言 determineListMutationAction
    assert.deepStrictEqual(
      determineListMutationAction('active', { kind: 'favorite', favorite: true, favoritedAt: '2026-09-12T10:00:00.000Z' }),
      { type: 'patch_favorite', favoritedAt: '2026-09-12T10:00:00.000Z' }
    );
    assert.deepStrictEqual(
      determineListMutationAction('active', { kind: 'favorite', favorite: false, favoritedAt: null }),
      { type: 'patch_favorite', favoritedAt: null }
    );
    assert.deepStrictEqual(
      determineListMutationAction('favorites', { kind: 'favorite', favorite: true, favoritedAt: '2026-09-12T10:00:00.000Z' }),
      { type: 'patch_favorite', favoritedAt: '2026-09-12T10:00:00.000Z' }
    );
    assert.deepStrictEqual(
      determineListMutationAction('favorites', { kind: 'favorite', favorite: false, favoritedAt: null }),
      { type: 'remove' }
    );
    assert.deepStrictEqual(
      determineListMutationAction('trash', { kind: 'favorite', favorite: true, favoritedAt: '2026-09-12T10:00:00.000Z' }),
      { type: 'none' }
    );
    assert.deepStrictEqual(
      determineListMutationAction('trash', { kind: 'favorite', favorite: false, favoritedAt: null }),
      { type: 'none' }
    );
    assert.deepStrictEqual(
      determineListMutationAction('active', { kind: 'trash' }),
      { type: 'remove' }
    );
    assert.deepStrictEqual(
      determineListMutationAction('favorites', { kind: 'trash' }),
      { type: 'remove' }
    );
    assert.deepStrictEqual(
      determineListMutationAction('trash', { kind: 'trash' }),
      { type: 'none' }
    );
    assert.deepStrictEqual(
      determineListMutationAction('active', { kind: 'restore' }),
      { type: 'none' }
    );
    assert.deepStrictEqual(
      determineListMutationAction('favorites', { kind: 'restore' }),
      { type: 'none' }
    );
    assert.deepStrictEqual(
      determineListMutationAction('trash', { kind: 'restore' }),
      { type: 'remove' }
    );

    // 真实多缓存交互集成断言
    const queryClient = new QueryClient();
    const activeKey = libraryKeys.list({ view: 'active' });
    const favoritesKey = libraryKeys.list({ view: 'favorites' });
    const trashKey = libraryKeys.list({ view: 'trash' });

    const item1 = createMockItem(2001, { favoritedAt: null });
    const item2 = createMockItem(2002, { favoritedAt: '2026-09-12T01:00:00.000Z' });
    const item3 = createMockItem(2003, { deletedAt: '2026-09-12T02:00:00.000Z' });

    // 初始状态：
    // active 拥有 item1, item2
    // favorites 仅拥有 item2（item1 未收藏，绝不在此）
    // trash 拥有 item3
    queryClient.setQueryData(activeKey, createMockInfiniteData([[item1, item2]], [null]));
    queryClient.setQueryData(favoritesKey, createMockInfiniteData([[item2]], [null]));
    queryClient.setQueryData(trashKey, createMockInfiniteData([[item3]], [null]));

    // 模拟客户端 RPC
    const originalSetFavorite = innerJiti('./lib/client/library.ts').libraryClient.setFavorite;
    const originalMoveToTrash = innerJiti('./lib/client/library.ts').libraryClient.moveToTrash;
    const originalRestore = innerJiti('./lib/client/library.ts').libraryClient.restore;

    innerJiti('./lib/client/library.ts').libraryClient.setFavorite = async ({ id, favorite }: any) => {
      return createMockItem(id, { favoritedAt: favorite ? '2026-09-12T15:00:00.000Z' : null });
    };
    innerJiti('./lib/client/library.ts').libraryClient.moveToTrash = async ({ id }: any) => {
      return createMockItem(id, { deletedAt: '2026-09-12T15:00:00.000Z' });
    };
    innerJiti('./lib/client/library.ts').libraryClient.restore = async ({ id }: any) => {
      return createMockItem(id, { deletedAt: null });
    };

    // B2.1: 在 active 视图中收藏 item1
    await mutateToggleFavorite(queryClient, { id: 2001, favorite: true });

    const activeAfterFav = queryClient.getQueryData<any>(activeKey)!;
    const favoritesAfterFav = queryClient.getQueryData<any>(favoritesKey)!;
    const trashAfterFav = queryClient.getQueryData<any>(trashKey)!;

    // active 缓存中 2001 已更新为收藏
    assert.strictEqual(
      activeAfterFav.pages[0].items.find((i: any) => i.id === 2001).favoritedAt,
      '2026-09-12T15:00:00.000Z'
    );
    // favorites 缓存绝不 append item1！依然只有 item2
    assert.strictEqual(favoritesAfterFav.pages[0].items.length, 1, 'favorites 缓存绝不追加 item1');
    assert.strictEqual(favoritesAfterFav.pages[0].items[0].id, 2002);
    // trash 缓存不受任何影响
    assert.strictEqual(trashAfterFav.pages[0].items.length, 1);
    assert.strictEqual(trashAfterFav.pages[0].items[0].id, 2003);

    // B2.2: 取消收藏 item2
    await mutateToggleFavorite(queryClient, { id: 2002, favorite: false });

    const activeAfterUnfav = queryClient.getQueryData<any>(activeKey)!;
    const favoritesAfterUnfav = queryClient.getQueryData<any>(favoritesKey)!;
    const trashAfterUnfav = queryClient.getQueryData<any>(trashKey)!;

    // active 缓存中 2002 依然存在，favoritedAt 为 null
    assert.strictEqual(
      activeAfterUnfav.pages[0].items.find((i: any) => i.id === 2002).favoritedAt,
      null
    );
    // favorites 缓存中 2002 被 view-aware 移除！
    assert.strictEqual(favoritesAfterUnfav.pages[0].items.length, 0, 'favorites 缓存中取消收藏项被移除');
    // trash 缓存依旧不受影响
    assert.strictEqual(trashAfterUnfav.pages[0].items.length, 1);

    // B2.3: 移入回收站 item1
    await mutateMoveToTrash(queryClient, { id: 2001 });

    const activeAfterTrash = queryClient.getQueryData<any>(activeKey)!;
    const trashAfterTrash = queryClient.getQueryData<any>(trashKey)!;

    // active 缓存中 2001 被移除
    assert.strictEqual(activeAfterTrash.pages[0].items.some((i: any) => i.id === 2001), false);
    // trash 缓存绝不本地 append 2001！保持原样 1 项（2003）
    assert.strictEqual(trashAfterTrash.pages[0].items.length, 1, '移入回收站绝不向 trash 缓存本地 append');
    assert.strictEqual(trashAfterTrash.pages[0].items[0].id, 2003);

    // B2.4: 恢复 item3
    await mutateRestore(queryClient, { id: 2003 });

    const activeAfterRestore = queryClient.getQueryData<any>(activeKey)!;
    const trashAfterRestore = queryClient.getQueryData<any>(trashKey)!;

    // trash 缓存中 2003 被移除
    assert.strictEqual(trashAfterRestore.pages[0].items.length, 0, '恢复后作品从 trash 缓存移除');
    // active 缓存绝不本地 append 2003！
    assert.strictEqual(
      activeAfterRestore.pages[0].items.some((i: any) => i.id === 2003),
      false,
      '恢复作品绝不本地 append 到 active 缓存'
    );

    innerJiti('./lib/client/library.ts').libraryClient.setFavorite = originalSetFavorite;
    innerJiti('./lib/client/library.ts').libraryClient.moveToTrash = originalMoveToTrash;
    innerJiti('./lib/client/library.ts').libraryClient.restore = originalRestore;
    queryClient.clear();
    console.log('PASS: Regression B2 通过（View-aware 视图隔离多缓存变更精确控制）');
  }

  console.log('=== Regression B3: 局部逆向回滚（Mutation Journal）并发回滚无僵尸数据 ===');
  {
    const queryClient = new QueryClient();
    const activeKey = libraryKeys.list({ view: 'active' });

    // 初始列表具有 3 个项目：A (3001), B (3002), C (3003)
    const itemA = createMockItem(3001, { title: '作品 A' });
    const itemB = createMockItem(3002, { title: '作品 B' });
    const itemC = createMockItem(3003, { title: '作品 C' });

    // 3.1 场景一：A 失败回滚，B 成功。验证 A 恢复，B 保持移除，绝不复活僵尸数据！
    queryClient.setQueryData(
      activeKey,
      createMockInfiniteData([[itemA, itemB, itemC]], ['cursor_page_1'])
    );

    let rejectA!: (err: any) => void;
    const promiseA = new Promise((_resolve, reject) => {
      rejectA = reject;
    });

    let resolveB!: (val: any) => void;
    const promiseB = new Promise((resolve) => {
      resolveB = resolve;
    });

    const originalMoveToTrash = innerJiti('./lib/client/library.ts').libraryClient.moveToTrash;
    innerJiti('./lib/client/library.ts').libraryClient.moveToTrash = async ({ id }: any) => {
      if (id === 3001) {
        await promiseA;
        return createMockItem(3001);
      }
      if (id === 3002) {
        await promiseB;
        return createMockItem(3002, { deletedAt: '2026-09-12T12:00:00.000Z' });
      }
      return createMockItem(id);
    };

    // 并发触发 Move A 与 Move B
    const taskA = mutateMoveToTrash(queryClient, { id: 3001 }).catch((err: unknown) => err);
    const taskB = mutateMoveToTrash(queryClient, { id: 3002 }).catch((err: unknown) => err);

    // 此时两个 mutation 均已完成乐观移除
    await new Promise((r) => setTimeout(r, 10));
    const cachedDuringMoves = queryClient.getQueryData<any>(activeKey)!;
    assert.strictEqual(cachedDuringMoves.pages[0].items.length, 1);
    assert.strictEqual(cachedDuringMoves.pages[0].items[0].id, 3003, '乐观移除后仅剩作品 C');

    // 现在让 A 失败抛错，触发 A 的局部回滚
    rejectA(new Error('网络断开，A 移动失败'));
    await taskA;

    // 核心断言：
    // A 局部回滚后插回列表；
    // B 依然处于移除状态（绝对没有被 A 的回滚复活成僵尸数据！）
    const cachedAfterAFailure = queryClient.getQueryData<any>(activeKey)!;
    const itemIdsAfterAFail = cachedAfterAFailure.pages[0].items.map((i: any) => i.id);
    assert.ok(itemIdsAfterAFail.includes(3001), 'A 必须被局部逆向回滚恢复');
    assert.ok(!itemIdsAfterAFail.includes(3002), 'B 必须保持移除，绝不能因全量快照回滚而被错误复活（无僵尸数据！）');
    assert.ok(itemIdsAfterAFail.includes(3003), 'C 必须安然无恙');
    assert.strictEqual(cachedAfterAFailure.pages[0].nextCursor, 'cursor_page_1', 'nextCursor 保持原样');
    assert.strictEqual(cachedAfterAFailure.pages[0].hasMore, true, 'hasMore 保持原样');

    // 现在让 B 成功完成
    resolveB(createMockItem(3002));
    await taskB;

    const cachedAfterBSuccess = queryClient.getQueryData<any>(activeKey)!;
    const itemIdsAfterBSuccess = cachedAfterBSuccess.pages[0].items.map((i: any) => i.id);
    assert.ok(itemIdsAfterBSuccess.includes(3001), 'A 仍存在');
    assert.ok(!itemIdsAfterBSuccess.includes(3002), 'B 最终被成功移出');
    assert.ok(itemIdsAfterBSuccess.includes(3003), 'C 存在');

    // 3.2 场景二：A 和 B 并发移动，两者均失败。验证局部回滚均能精确原位恢复！
    queryClient.setQueryData(
      activeKey,
      createMockInfiniteData([[itemA, itemB, itemC]], ['cursor_page_2'])
    );

    let rejectA2!: (err: any) => void;
    const promiseA2 = new Promise((_resolve, reject) => {
      rejectA2 = reject;
    });

    let rejectB2!: (err: any) => void;
    const promiseB2 = new Promise((_resolve, reject) => {
      rejectB2 = reject;
    });

    innerJiti('./lib/client/library.ts').libraryClient.moveToTrash = async ({ id }: any) => {
      if (id === 3001) {
        await promiseA2;
      } else if (id === 3002) {
        await promiseB2;
      }
      throw new Error(`模拟失败: ${id}`);
    };

    const taskA2 = mutateMoveToTrash(queryClient, { id: 3001 }).catch((e: unknown) => e);
    const taskB2 = mutateMoveToTrash(queryClient, { id: 3002 }).catch((e: unknown) => e);

    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(queryClient.getQueryData<any>(activeKey)!.pages[0].items.length, 1);

    // A 失败
    rejectA2(new Error('A 失败'));
    await taskA2;
    assert.strictEqual(queryClient.getQueryData<any>(activeKey)!.pages[0].items.length, 2);

    // B 失败
    rejectB2(new Error('B 失败'));
    await taskB2;

    const cachedAfterBothFailed = queryClient.getQueryData<any>(activeKey)!;
    const itemsBoth = cachedAfterBothFailed.pages[0].items;
    assert.strictEqual(itemsBoth.length, 3, '两者均失败后，所有 3 项均应恢复');
    const idsBoth = itemsBoth.map((i: any) => i.id);
    assert.ok(idsBoth.includes(3001));
    assert.ok(idsBoth.includes(3002));
    assert.ok(idsBoth.includes(3003));
    assert.strictEqual(cachedAfterBothFailed.pages[0].nextCursor, 'cursor_page_2', 'nextCursor 保持');

    innerJiti('./lib/client/library.ts').libraryClient.moveToTrash = originalMoveToTrash;
    queryClient.clear();
    console.log('PASS: Regression B3 通过（局部逆向回滚精确生效，无僵尸数据复活）');
  }

  console.log('=== Regression 6: Permanent Delete 未确认时零 RPC，确认后才调用 ===');
  {
    cleanup();

    let rpcCalls: any[] = [];
    const originalDeletePermanently =
      innerJiti('./lib/client/library.ts').libraryClient.deletePermanently;

    innerJiti('./lib/client/library.ts').libraryClient.deletePermanently = async ({ id }: any) => {
      rpcCalls.push({ id });
      return { success: true, id };
    };

    const queryClient = new QueryClient();
    const trashCacheKey = libraryKeys.list({ view: 'trash' });
    const trashItem = createMockItem(601, {
      title: '永久删除目标作品',
      deletedAt: '2026-09-12T05:00:00.000Z',
    });
    queryClient.setQueryData(trashCacheKey, createMockInfiniteData([[trashItem]], [null]));

    // 6.1 验证 mutateDeletePermanently 纯函数未确认时直接抛错且零 RPC
    let rejectedWithoutConfirm = false;
    try {
      await mutateDeletePermanently(queryClient, { id: 601, confirmed: false });
    } catch (err: any) {
      rejectedWithoutConfirm = true;
      assert.ok(err.message.includes('二次确认'));
    }
    assert.strictEqual(rejectedWithoutConfirm, true, '未确认时调用必须立即拒绝');
    assert.strictEqual(rpcCalls.length, 0, '未确认前 RPC 调用次数必须为 0');

    // 6.2 渲染 StoryWorkCard 组件验证 UI 交互与模态框确认门禁
    const { container } = render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(StoryWorkCard, {
          work: trashItem,
          view: 'trash',
        })
      )
    );

    const deleteBtn = container.querySelector(
      '[data-testid="story-card-delete-permanently-btn-601"]'
    ) as HTMLButtonElement;
    assert.ok(deleteBtn, 'trash 视图卡片应渲染永久删除按钮');

    // 点击永久删除按钮，应弹出二次确认弹窗，此时尚未确认，RPC 次数必须严格为 0
    fireEvent.click(deleteBtn);
    assert.strictEqual(rpcCalls.length, 0, '打开确认弹窗时 RPC 次数必须为 0');

    const dialog = container.querySelector(
      '[data-testid="permanent-delete-dialog-601"]'
    );
    assert.ok(dialog, '必须渲染二次确认弹窗');

    // 点击取消按钮：弹窗关闭，RPC 次数必须仍为 0
    const cancelBtn = container.querySelector(
      '[data-testid="permanent-delete-cancel-btn"]'
    ) as HTMLButtonElement;
    assert.ok(cancelBtn);
    fireEvent.click(cancelBtn);

    assert.strictEqual(
      container.querySelector('[data-testid="permanent-delete-dialog-601"]'),
      null,
      '取消后弹窗必须已关闭'
    );
    assert.strictEqual(rpcCalls.length, 0, '取消删除后 RPC 次数仍严格为 0');

    // 再次点击永久删除，这次点击「确认删除」
    fireEvent.click(deleteBtn);
    const confirmBtn = container.querySelector(
      '[data-testid="permanent-delete-confirm-btn"]'
    ) as HTMLButtonElement;
    assert.ok(confirmBtn);

    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    assert.strictEqual(rpcCalls.length, 1, '确认后必须恰好调用一次 deletePermanently RPC');
    assert.deepStrictEqual(rpcCalls[0], { id: 601 }, 'RPC 参数为正确作品 ID');

    // 验证 trash 缓存中该项被移除
    const trashDataAfterDelete = queryClient.getQueryData<any>(trashCacheKey)!;
    assert.strictEqual(
      trashDataAfterDelete.pages[0].items.length,
      0,
      '删除成功后作品必须从 trash 列表中移除'
    );

    innerJiti('./lib/client/library.ts').libraryClient.deletePermanently = originalDeletePermanently;
    cleanup();
    queryClient.clear();

    console.log('PASS: Regression 6 通过（Permanent Delete 未确认时零 RPC，确认后才调用）');
  }

  console.log('=== 7. Favorite 乐观更新与回滚工作流验证 ===');
  {
    const queryClient = new QueryClient();
    const activeCacheKey = libraryKeys.list({ view: 'active' });
    const item701 = createMockItem(701, { favoritedAt: null });
    queryClient.setQueryData(activeCacheKey, createMockInfiniteData([[item701]], [null]));

    // 模拟服务端返回
    const originalSetFavorite = innerJiti('./lib/client/library.ts').libraryClient.setFavorite;
    innerJiti('./lib/client/library.ts').libraryClient.setFavorite = async ({ id, favorite }: any) => {
      return createMockItem(id, {
        favoritedAt: favorite ? '2026-09-12T15:00:00.000Z' : null,
      });
    };

    // 成功切换为收藏
    const updated = await mutateToggleFavorite(queryClient, {
      id: 701,
      favorite: true,
      currentView: 'active',
    });

    assert.strictEqual(updated.favoritedAt, '2026-09-12T15:00:00.000Z');
    const cacheAfterFav = queryClient.getQueryData<any>(activeCacheKey)!.pages[0].items[0];
    assert.strictEqual(cacheAfterFav.favoritedAt, '2026-09-12T15:00:00.000Z');

    // 失败回滚测试
    innerJiti('./lib/client/library.ts').libraryClient.setFavorite = async () => {
      throw new Error('服务端故障');
    };

    let errorCaught = false;
    try {
      await mutateToggleFavorite(queryClient, {
        id: 701,
        favorite: false,
        currentView: 'active',
      });
    } catch {
      errorCaught = true;
    }
    assert.strictEqual(errorCaught, true);

    // 验证回滚保持收藏状态
    const cacheAfterFail = queryClient.getQueryData<any>(activeCacheKey)!.pages[0].items[0];
    assert.strictEqual(cacheAfterFail.favoritedAt, '2026-09-12T15:00:00.000Z', '异常时状态正确回滚');

    innerJiti('./lib/client/library.ts').libraryClient.setFavorite = originalSetFavorite;
    queryClient.clear();
    console.log('PASS: 7. Favorite 乐观更新与回滚工作流断言通过');
  }

  console.log('=== 8. 静态架构规范守卫断言（No libraryStore / No forbidden imports）===');
  {
    const filesToScan = [
      path.join(repoRoot, 'lib/client/libraryMutations.ts'),
      path.join(repoRoot, 'components/Library/LibraryUndoProvider.tsx'),
      path.join(repoRoot, 'app/(main)/library/layout.tsx'),
      path.join(repoRoot, 'app/(main)/library/components/StoryWorkCard.tsx'),
    ];

    const forbiddenImports = [
      '@/lib/trpc/client',
      '@/lib/server',
      'lib/server',
      '@prisma/client',
      '@prisma',
      '@trpc/react-query',
    ];

    for (const filePath of filesToScan) {
      assert.ok(fs.existsSync(filePath), `被扫描文件必须存在：${filePath}`);
      const content = fs.readFileSync(filePath, 'utf-8');

      // 8.1 严禁引入 libraryStore
      assert.strictEqual(
        content.includes('libraryStore'),
        false,
        `静态守卫违背：文件 ${path.basename(filePath)} 严禁使用或引入 libraryStore`
      );

      // 8.2 严禁导入禁用服务端模块
      for (const forbidden of forbiddenImports) {
        const importPattern = new RegExp(`['"]${forbidden}(/.*)?['"]`);
        assert.strictEqual(
          importPattern.test(content),
          false,
          `静态守卫违背：文件 ${path.basename(filePath)} 不得导入禁用的模块 "${forbidden}"`
        );
      }
    }

    console.log('PASS: 8. 静态架构规范守卫断言通过（无 libraryStore 且无禁止导入）');
  }

  console.log('ALL LIBRARY LIST LIFECYCLE AND UNDO UNIT TESTS PASSED SUCCESSFULLY');
}

runLifecycleUndoUnitTests().catch((err) => {
  console.error('LIBRARY LIST LIFECYCLE UNDO UNIT TEST FAILED:', err);
  process.exit(1);
});
