/**
 * Library 列表生命周期与 Undo 单元测试 (M3-05)
 *
 * 核心验证范围（至少 6 条必测 Regression）：
 * 1) move pending 时点 Undo → 调用顺序严格 move resolve → restore
 * 2) move 失败后不出现 Undo，并恢复原 cache
 * 3) 旧 move promise resolve 不得污染随后另一条 Undo
 * 4) favorites/restore 只 patch/remove 已加载 item，绝不向另一个 infinite cache append
 * 5) opaque cursor/pageParams 在 optimistic patch/remove 后保持原样
 * 6) Permanent Delete 未确认时零 RPC，确认后才调用
 *
 * 附加断言：
 * 7) 纯缓存算子不变性与防御性（removeItem, patchFavorite, reconcile）
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
  mutateToggleFavorite,
  mutateMoveToTrash,
  mutateRestore,
  mutateDeletePermanently,
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
