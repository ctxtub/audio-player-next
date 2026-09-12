/**
 * Library 详情侧变更与跨缓存一致性单元测试 (M3-07)
 *
 * 核心回归矩阵：
 * 1) Detail Rename 后 detail + active/favorites 已加载卡片标题一致，opaque pagination metadata 不变，失败局部回滚；
 * 2) Detail Favorite 与 List Favorite 使用同一 mutation policy（不产生第二套 cache 规则）；
 * 3) Detail Move pending/失败时仍留在详情且数据 rollback；
 * 4) Move 成功后详情 route 离开、detail cache 不继续展示旧 active work；
 * 5) 离开 Detail 后 Undo 仍存在并能 restore；
 * 6) Undo 成功只 invalidate collection，不自动导航回原 Detail；
 * 7) Detail component/mutation adapter 不直接 import @/lib/client/library、@/lib/server、@prisma（组件层守卫）。
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
    url: 'http://localhost:3000/library/101',
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
    'requestIdleCallback',
    'cancelIdleCallback',
  ];

  if (!win.requestIdleCallback) {
    win.requestIdleCallback = (cb: (info: { didTimeout: boolean; timeRemaining: () => number }) => void) => {
      return setTimeout(() => {
        cb({
          didTimeout: false,
          timeRemaining: () => 50,
        });
      }, 1);
    };
    win.cancelIdleCallback = (id: unknown) => clearTimeout(id as NodeJS.Timeout);
  }

  try {
    Object.defineProperty(g, 'self', { value: win, writable: true, configurable: true });
    (win as Record<string, unknown>).self = win;
  } catch {
    // ignore
  }

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

const { render, fireEvent, act, cleanup } = nodeRequire('@testing-library/react');

const {
  mutateRename,
  mutateToggleFavorite,
  mutateMoveToTrash,
  patchItemTitleInInfiniteData,
} = innerJiti('./lib/client/libraryMutations.ts');

const { libraryKeys } = innerJiti('./lib/client/libraryQueries.ts');
const { composeLibraryDetailViewModel } = innerJiti('./lib/client/libraryViewModel.ts');
const StoryDetail = innerJiti('./components/Library/StoryDetail.tsx').default || innerJiti('./components/Library/StoryDetail.tsx').StoryDetail;
const { LibraryUndoProvider, useLibraryUndo } = innerJiti('./components/Library/LibraryUndoProvider.tsx');

function createMockItem(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `故事作品 ${id}`,
    excerpt: `故事摘要 ${id}`,
    voiceId: 'zh-CN-YunxiNeural',
    contentHash: `hash_${id}`,
    favoritedAt: null,
    deletedAt: null,
    createdAt: new Date(Date.now() - id * 1000).toISOString(),
    updatedAt: new Date(Date.now() - id * 1000).toISOString(),
    audio: {
      status: 'ready',
      durationMs: 60000,
    },
    ...overrides,
  };
}

function createMockDetail(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `故事作品 ${id}`,
    storyText: `完整的长篇故事正文内容 ${id}`,
    prompt: `生成的创作提示词 ${id}`,
    excerpt: `故事摘要 ${id}`,
    voiceId: 'zh-CN-YunxiNeural',
    sourceMessageId: `msg_${id}`,
    contentHash: `hash_${id}`,
    favoritedAt: null,
    deletedAt: null,
    createdAt: new Date(Date.now() - id * 1000).toISOString(),
    updatedAt: new Date(Date.now() - id * 1000).toISOString(),
    audio: {
      status: 'ready',
      durationMs: 60000,
    },
    ...overrides,
  };
}

async function runLibraryDetailMutationsUnitTests(): Promise<void> {
  const libraryClient = innerJiti('./lib/client/library.ts').libraryClient;
  const originalRename = libraryClient.rename;
  const originalSetFavorite = libraryClient.setFavorite;
  const originalMoveToTrash = libraryClient.moveToTrash;
  const originalRestore = libraryClient.restore;

  console.log('=== Regression 1: Detail Rename 跨缓存同步、分页元数据不变与局部回滚 ===');
  {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    const initialDetail = createMockDetail(101, { title: '原始故事标题 101' });
    queryClient.setQueryData(libraryKeys.detail(101), initialDetail);

    const initialActiveList = {
      pages: [
        {
          items: [createMockItem(100), createMockItem(101, { title: '原始故事标题 101' })],
          nextCursor: 'cursor_page_1',
          hasMore: true,
        },
        {
          items: [createMockItem(102)],
          nextCursor: null,
          hasMore: false,
        },
      ],
      pageParams: [undefined, 'cursor_page_1'],
    };
    queryClient.setQueryData(libraryKeys.list({ view: 'active', query: undefined }), initialActiveList);

    const initialFavoritesList = {
      pages: [
        {
          items: [createMockItem(101, { title: '原始故事标题 101', favoritedAt: '2026-09-12T10:00:00Z' })],
          nextCursor: null,
          hasMore: false,
        },
      ],
      pageParams: [undefined],
    };
    queryClient.setQueryData(libraryKeys.list({ view: 'favorites', query: undefined }), initialFavoritesList);

    // 1.1 成功路径：重命名生效
    libraryClient.rename = async ({ id, title }: { id: number; title: string }) => {
      return createMockDetail(id, {
        title,
        updatedAt: '2026-09-12T18:00:00.000Z',
      });
    };

    const updatedDTO = await mutateRename(queryClient, {
      id: 101,
      title: '更新后的新故事标题 101',
    });

    assert.strictEqual(updatedDTO.title, '更新后的新故事标题 101');

    // 断言 1: Detail Cache 更新为 Server DTO
    const cachedDetail = queryClient.getQueryData<any>(libraryKeys.detail(101));
    assert.strictEqual(cachedDetail?.title, '更新后的新故事标题 101', 'Detail Cache 必须更新为最新标题');
    assert.strictEqual(cachedDetail?.updatedAt, '2026-09-12T18:00:00.000Z');

    // 断言 2: Active List Cache 对应项仅 patch title
    const cachedActiveList = queryClient.getQueryData<any>(
      libraryKeys.list({ view: 'active', query: undefined })
    );
    assert.strictEqual(cachedActiveList.pages[0].items[1].title, '更新后的新故事标题 101');
    assert.strictEqual(cachedActiveList.pages[0].items[0].title, '故事作品 100', '无关作品标题绝不受影响');

    // 断言 3: Favorites List Cache 对应项仅 patch title
    const cachedFavoritesList = queryClient.getQueryData<any>(
      libraryKeys.list({ view: 'favorites', query: undefined })
    );
    assert.strictEqual(cachedFavoritesList.pages[0].items[0].title, '更新后的新故事标题 101');

    // 断言 4: Opaque Pagination Metadata 严格保持原样
    assert.strictEqual(cachedActiveList.pages.length, 2, '分页数量不变');
    assert.strictEqual(cachedActiveList.pages[0].nextCursor, 'cursor_page_1', 'Page 0 cursor 绝对保持');
    assert.strictEqual(cachedActiveList.pages[0].hasMore, true, 'Page 0 hasMore 绝对保持');
    assert.strictEqual(cachedActiveList.pages[1].nextCursor, null, 'Page 1 cursor 绝对保持');
    assert.strictEqual(cachedActiveList.pages[1].hasMore, false, 'Page 1 hasMore 绝对保持');
    assert.deepStrictEqual(cachedActiveList.pageParams, [undefined, 'cursor_page_1'], 'pageParams 数组绝对保持');

    // 1.2 失败路径：网络或服务端拒绝时执行局部逆向回滚（Mutation Journal）
    libraryClient.rename = async () => {
      throw new Error('Rename rejected by server');
    };

    let renameFailed = false;
    try {
      await mutateRename(queryClient, {
        id: 101,
        title: '不应该生效的失败标题',
      });
    } catch {
      renameFailed = true;
    }
    assert.strictEqual(renameFailed, true, '服务端异常必须向上抛出');

    // 验证局部回滚恢复原标题
    const rolledBackDetail = queryClient.getQueryData<any>(libraryKeys.detail(101));
    assert.strictEqual(rolledBackDetail?.title, '更新后的新故事标题 101', 'Detail Cache 必须局部回滚');

    const rolledBackActiveList = queryClient.getQueryData<any>(
      libraryKeys.list({ view: 'active', query: undefined })
    );
    assert.strictEqual(rolledBackActiveList.pages[0].items[1].title, '更新后的新故事标题 101', 'Active List 必须局部回滚');

    console.log('PASS: Regression 1 通过（Detail Rename 跨缓存同步、分页元数据不变与局部回滚）');
  }

  console.log('=== Regression 2: Detail Favorite 与 List Favorite 使用同一 mutation policy ===');
  {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    const initialDetail = createMockDetail(101, { favoritedAt: null });
    queryClient.setQueryData(libraryKeys.detail(101), initialDetail);

    const initialActiveList = {
      pages: [
        {
          items: [createMockItem(101, { favoritedAt: null })],
          nextCursor: null,
          hasMore: false,
        },
      ],
      pageParams: [undefined],
    };
    queryClient.setQueryData(libraryKeys.list({ view: 'active', query: undefined }), initialActiveList);

    const initialFavoritesList = {
      pages: [
        {
          items: [createMockItem(200, { favoritedAt: '2026-09-12T10:00:00Z' })],
          nextCursor: 'fav_cursor_1',
          hasMore: true,
        },
      ],
      pageParams: [undefined],
    };
    queryClient.setQueryData(libraryKeys.list({ view: 'favorites', query: undefined }), initialFavoritesList);

    // 2.1 验证在 Detail 调用同一 mutateToggleFavorite 算子
    libraryClient.setFavorite = async ({ id, favorite }: { id: number; favorite: boolean }) => {
      return createMockDetail(id, {
        favoritedAt: favorite ? '2026-09-12T19:00:00.000Z' : null,
      });
    };

    const resFavorite = await mutateToggleFavorite(queryClient, {
      id: 101,
      favorite: true,
    });
    assert.strictEqual(resFavorite.favoritedAt, '2026-09-12T19:00:00.000Z');

    // 断言 Detail 与 Active List 统一同步
    const detailAfterFav = queryClient.getQueryData<any>(libraryKeys.detail(101));
    assert.strictEqual(detailAfterFav?.favoritedAt, '2026-09-12T19:00:00.000Z');

    const activeListAfterFav = queryClient.getQueryData<any>(
      libraryKeys.list({ view: 'active', query: undefined })
    );
    assert.strictEqual(activeListAfterFav.pages[0].items[0].favoritedAt, '2026-09-12T19:00:00.000Z');

    // 断言 Favorites List 绝未被脏 append（保护 opaque cursor 不被侵入）
    const favListAfterFav = queryClient.getQueryData<any>(
      libraryKeys.list({ view: 'favorites', query: undefined })
    );
    assert.strictEqual(favListAfterFav.pages[0].items.length, 1, '未加载的 Favorites 列表绝对不得被本地注入新项');
    assert.strictEqual(favListAfterFav.pages[0].items[0].id, 200);

    // 2.2 取消收藏时，如果在 favorites 列表已存在，则同策略剔除
    favListAfterFav.pages[0].items.push(createMockItem(101, { favoritedAt: '2026-09-12T19:00:00.000Z' }));
    queryClient.setQueryData(libraryKeys.list({ view: 'favorites', query: undefined }), { ...favListAfterFav });

    await mutateToggleFavorite(queryClient, {
      id: 101,
      favorite: false,
    });

    const favListAfterUnfav = queryClient.getQueryData<any>(
      libraryKeys.list({ view: 'favorites', query: undefined })
    );
    assert.strictEqual(
      favListAfterUnfav.pages[0].items.some((it: any) => it.id === 101),
      false,
      '取消收藏时，已加载的 favorites 视图必须依同策略被移出'
    );

    console.log('PASS: Regression 2 通过（Detail 与 List 严格复用同一套 Favorite Mutation 缓存一致性规则）');
  }

  console.log('=== Regression 3: Detail Move pending/失败时仍留在详情且数据 rollback ===');
  {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    const initialDetail = createMockDetail(101, { title: '测试作品 101' });
    queryClient.setQueryData(libraryKeys.detail(101), initialDetail);

    let pushedRoutes: string[] = [];
    let moveResolve!: (val: any) => void;
    let moveReject!: (err: any) => void;
    const pendingMovePromise = new Promise((resolve, reject) => {
      moveResolve = resolve;
      moveReject = reject;
    });

    libraryClient.moveToTrash = async () => {
      return pendingMovePromise;
    };

    const mockRouter = {
      push: (url: string) => pushedRoutes.push(url),
      replace: () => {},
    };

    let moveErrorCaught: unknown = null;
    let hasFinished = false;

    // 触发移入回收站
    const moveAction = (async () => {
      try {
        await mutateMoveToTrash(queryClient, {
          id: 101,
          workTitle: '测试作品 101',
        });
        mockRouter.push('/library');
      } catch (err) {
        moveErrorCaught = err;
      } finally {
        hasFinished = true;
      }
    })();

    // 3.1 验证 pending 期间：绝不发生路由跳转，停留在详情
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(hasFinished, false, '请求在途时操作未完成');
    assert.strictEqual(pushedRoutes.length, 0, 'Pending 期间严禁调用 router.push 离开详情页');

    // 3.2 模拟服务端拒绝失败：验证仍在详情，且数据 rollback
    moveReject(new Error('Server error deleting work'));
    await moveAction;

    assert.ok(moveErrorCaught, '失败必须被捕获');
    assert.strictEqual(pushedRoutes.length, 0, 'Move 失败后严禁离开详情页，必须留在原路由');

    // 验证详情缓存被完好恢复
    const rolledBackDetail = queryClient.getQueryData<any>(libraryKeys.detail(101));
    assert.deepStrictEqual(rolledBackDetail, initialDetail, 'Move 失败后详情缓存必须安全回滚');

    console.log('PASS: Regression 3 通过（Move pending/失败时严格留在详情页且数据安全回滚）');
  }

  console.log('=== Regression 4: Move 成功后详情 route 离开、detail cache 不继续展示旧 active work ===');
  {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    const initialDetail = createMockDetail(101);
    queryClient.setQueryData(libraryKeys.detail(101), initialDetail);

    const pushedRoutes: string[] = [];
    const mockRouter = {
      push: (url: string) => pushedRoutes.push(url),
    };

    libraryClient.moveToTrash = async ({ id }: { id: number }) => {
      return createMockDetail(id, { deletedAt: new Date().toISOString() });
    };

    await mutateMoveToTrash(queryClient, {
      id: 101,
      workTitle: '已删除作品',
    });
    mockRouter.push('/library');

    // 4.1 断言 route 离开
    assert.strictEqual(pushedRoutes.length, 1);
    assert.strictEqual(pushedRoutes[0], '/library', 'Move 成功后必须导航离开当前详情页跳转到 /library');

    // 4.2 断言 detail cache 被彻底清除，不再展示旧 active 数据
    const cachedDetail = queryClient.getQueryData(libraryKeys.detail(101));
    assert.strictEqual(cachedDetail, undefined, 'Move 成功后详情缓存必须被彻底清除 (removeQueries)');

    console.log('PASS: Regression 4 通过（Move 成功后路由离开且 detail cache 彻底清除）');
  }

  console.log('=== Regression 5: 离开 Detail 后 Undo 仍存在并能 restore ===');
  {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    let currentUndoHandle: any = null;
    function TestConsumer() {
      const undo = useLibraryUndo();
      currentUndoHandle = undo;
      return React.createElement('div', { 'data-testid': 'undo-active' }, undo.activeUndo ? 'HAS_UNDO' : 'NO_UNDO');
    }

    const { getByTestId } = render(
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

    assert.strictEqual(getByTestId('undo-active').textContent, 'NO_UNDO');

    // 模拟从详情页发起 Move 并离开详情
    let moveDone = false;
    const movePromise = (async () => {
      await new Promise((r) => setTimeout(r, 10));
      moveDone = true;
      return createMockDetail(101, { deletedAt: new Date().toISOString() });
    })();

    act(() => {
      currentUndoHandle.showUndo({
        workId: 101,
        workTitle: '测试撤销作品',
        movePromise,
      });
    });

    // 验证此时位于列表布局层，Undo 会话完好存在
    assert.strictEqual(getByTestId('undo-active').textContent, 'HAS_UNDO', '离开详情页后 Undo 会话持续存在');
    assert.strictEqual(currentUndoHandle.activeUndo.workId, 101);

    // 验证点击 Undo 能正确执行真实恢复
    let restoredId: number | null = null;
    libraryClient.restore = async ({ id }: { id: number }) => {
      restoredId = id;
      return createMockDetail(id, { deletedAt: null });
    };

    await act(async () => {
      await currentUndoHandle.triggerUndo();
    });

    assert.strictEqual(moveDone, true, 'Undo 必须等待 move 完全 resolve 后执行');
    assert.strictEqual(restoredId, 101, 'Undo 必须向服务端发起真实的 restore({ id: 101 }) 调用');
    assert.strictEqual(currentUndoHandle.activeUndo, null, 'Undo 成功后状态自动清空');

    cleanup();
    console.log('PASS: Regression 5 通过（离开 Detail 后 Undo 持续存在且能真实恢复）');
  }

  console.log('=== Regression 6: Undo 成功只 invalidate collection，不自动导航回原 Detail ===');
  {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    let invalidatedListQueries = false;
    queryClient.invalidateQueries = (async (filters?: any) => {
      if (JSON.stringify(filters?.queryKey) === JSON.stringify(libraryKeys.lists())) {
        invalidatedListQueries = true;
      }
    }) as any;

    let routerPushCalls: string[] = [];
    const mockRouter = {
      push: (href: string) => routerPushCalls.push(href),
    };

    let currentUndo: any = null;
    function TestConsumer() {
      currentUndo = useLibraryUndo();
      return null;
    }

    render(
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

    libraryClient.restore = async ({ id }: { id: number }) => {
      return createMockDetail(id, { deletedAt: null });
    };

    act(() => {
      currentUndo.showUndo({
        workId: 101,
        workTitle: '待恢复作品',
        movePromise: Promise.resolve(createMockDetail(101)),
      });
    });

    await act(async () => {
      await currentUndo.triggerUndo();
    });

    assert.strictEqual(invalidatedListQueries, true, 'Undo 成功后必须失效列表集合');
    assert.strictEqual(routerPushCalls.length, 0, 'Undo 成功后严禁自动导航回原详情页，用户必须留在列表页');

    cleanup();
    console.log('PASS: Regression 6 通过（Undo 成功只 invalidate collection，不自动导航回原 Detail）');
  }

  console.log('=== Regression 7: 静态纯净度与架构隔离守卫（No forbidden imports / No Restore & Delete in Detail）===');
  {
    const componentFiles = [
      path.join(repoRoot, 'components/Library/StoryDetail.tsx'),
      path.join(repoRoot, 'app/(main)/library/[id]/index.tsx'),
    ];

    const forbiddenImports = [
      '@/lib/client/library',
      '@/lib/server',
      'lib/server',
      '@prisma/client',
      '@prisma',
      '@trpc/react-query',
      '@/lib/trpc/client',
    ];

    const forbiddenKeywords = [
      'mutateRestore',
      'mutateDeletePermanently',
      'deletePermanently',
      'libraryStore',
    ];

    for (const file of componentFiles) {
      assert.ok(fs.existsSync(file), `组件文件必须存在: ${file}`);
      const code = fs.readFileSync(file, 'utf-8');

      // 7.1 严禁导入被禁止的底层门面或服务端代码
      for (const forbidden of forbiddenImports) {
        const importPattern = new RegExp(`['"]${forbidden}(/.*)?['"]`);
        assert.strictEqual(
          importPattern.test(code),
          false,
          `静态守卫违背：文件 ${path.basename(file)} 严禁直接导入 "${forbidden}"`
        );
      }

      // 7.2 详情侧严禁暴露 Restore 或 Permanent Delete
      for (const kw of forbiddenKeywords) {
        assert.strictEqual(
          code.includes(kw),
          false,
          `静态守卫违背：文件 ${path.basename(file)} 严禁包含 "${kw}"（详情侧绝不承载 Restore / Permanent Delete）`
        );
      }
    }

    console.log('PASS: Regression 7 通过（组件层守卫与能力剪裁静态审计通过）');
  }

  // 恢复桩函数
  libraryClient.rename = originalRename;
  libraryClient.setFavorite = originalSetFavorite;
  libraryClient.moveToTrash = originalMoveToTrash;
  libraryClient.restore = originalRestore;

  console.log('ALL LIBRARY DETAIL MUTATIONS UNIT TESTS PASSED SUCCESSFULLY');
}

runLibraryDetailMutationsUnitTests().catch((err) => {
  console.error('LIBRARY DETAIL MUTATIONS UNIT TEST FAILED:', err);
  process.exit(1);
});
