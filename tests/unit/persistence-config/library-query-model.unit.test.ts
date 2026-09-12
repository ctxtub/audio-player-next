import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  libraryKeys,
  libraryListInfiniteQueryOptions,
  libraryDetailQueryOptions,
  DEFAULT_LIBRARY_LIMIT,
} from '../../../lib/client/libraryQueries';
import {
  composeLibraryItemViewModel,
  composeLibraryDetailViewModel,
  composeLibraryItemListViewModel,
} from '../../../lib/client/libraryViewModel';
import { libraryClient } from '../../../lib/client/library';
import type {
  StoryWorkSummaryDTO,
  StoryWorkDetailDTO,
  LibraryListOutput,
} from '../../../lib/client/library';

/**
 * M3-02: Library Query Model / ViewModel Boundary 单元测试套件。
 *
 * 核心验证：
 * 1. query keys 规范与结构（list key 绝不含 cursor；detail 映射正确）；
 * 2. getNextPageParam 契约（hasMore=true+nextCursor → 返回 nextCursor；hasMore=false → undefined；nextCursor=null → undefined）；
 * 3. Detail Query 契约（queryKey 与 queryFn 委托）；
 * 4. ViewModel 合成边界（M5 progress null/injection 缝隙；audio 形状与元数据完全保持）；
 * 5. 静态守卫断言（源码扫描：严禁任何禁用 import 泄漏）。
 */
async function runLibraryQueryModelUnitTests() {
  console.log('=== 1. query keys 结构与规范断言（list 绝无 cursor；detail 键正确）===');
  {
    // 1.1 基础层级
    assert.deepStrictEqual(libraryKeys.all, ['library'], 'libraryKeys.all 必须为 [library]');
    assert.deepStrictEqual(libraryKeys.lists(), ['library', 'list'], 'libraryKeys.lists() 必须为 [library, list]');
    assert.deepStrictEqual(libraryKeys.details(), ['library', 'detail'], 'libraryKeys.details() 必须为 [library, detail]');

    // 1.2 list key 结构断言
    const activeListKey = libraryKeys.list({ view: 'active', query: 'hero' });
    assert.deepStrictEqual(
      activeListKey,
      ['library', 'list', { view: 'active', query: 'hero' }],
      'list key 必须形如 [library, list, { view, query }]'
    );

    const trashListKey = libraryKeys.list({ view: 'trash' });
    assert.deepStrictEqual(
      trashListKey,
      ['library', 'list', { view: 'trash', query: undefined }],
      '未传 query 时必须设为 undefined'
    );

    const defaultListKey = libraryKeys.list();
    assert.deepStrictEqual(
      defaultListKey,
      ['library', 'list', { view: 'active', query: undefined }],
      '缺省参数时 view 必须默认为 active'
    );

    // 核心契约断言：list key 绝不能含 cursor
    const filterObj = activeListKey[2] as Record<string, unknown>;
    assert.strictEqual(
      'cursor' in filterObj,
      false,
      '核心契约：List query key 绝对禁止包含 cursor（cursor 仅作为 pageParam 存在）'
    );

    // 1.3 detail key 结构断言
    const detailKey = libraryKeys.detail(42);
    assert.deepStrictEqual(detailKey, ['library', 'detail', 42], 'detail key 必须形如 [library, detail, id]');

    console.log('PASS: 1. query keys 结构与规范断言通过');
  }

  console.log('=== 2. Infinite Query 契约与 getNextPageParam 全边界断言 ===');
  {
    assert.strictEqual(DEFAULT_LIBRARY_LIMIT, 20, '默认分页大小契约必须固定为 20');

    const queryOpts = libraryListInfiniteQueryOptions({ view: 'active', query: 'test' });
    assert.strictEqual(queryOpts.initialPageParam, undefined, 'initialPageParam 必须固定为 undefined');

    // 2.1 getNextPageParam 契约验证
    const getNextPageParam = queryOpts.getNextPageParam;
    assert.strictEqual(typeof getNextPageParam, 'function', 'getNextPageParam 必须为函数');

    // 规则 1：hasMore=true 且 nextCursor 有值 → 返回 nextCursor
    const pageWithMore: LibraryListOutput = {
      items: [],
      nextCursor: 'cursor_page_2',
      hasMore: true,
    };
    assert.strictEqual(
      getNextPageParam(pageWithMore, [pageWithMore], 'cursor_page_1', ['cursor_page_1']),
      'cursor_page_2',
      'hasMore=true 且 nextCursor 非空时必须返回 nextCursor'
    );

    // 规则 2：hasMore=false 且 nextCursor=null → undefined（已无后续页）
    const lastPage: LibraryListOutput = {
      items: [],
      nextCursor: null,
      hasMore: false,
    };
    assert.strictEqual(
      getNextPageParam(lastPage, [lastPage], undefined, []),
      undefined,
      'hasMore=false 且 nextCursor=null 时必须返回 undefined'
    );

    // 规则 3：防守断言：即使 nextCursor 有脏残留，只要 hasMore=false 一律返回 undefined
    const dirtyLastPage: LibraryListOutput = {
      items: [],
      nextCursor: 'dirty_cursor_should_ignore',
      hasMore: false,
    };
    assert.strictEqual(
      getNextPageParam(dirtyLastPage, [dirtyLastPage], undefined, []),
      undefined,
      'hasMore=false 时哪怕 nextCursor 有值也必须返回 undefined'
    );

    // 规则 4：防守断言：哪怕 hasMore=true，若 nextCursor 为 null 一律返回 undefined
    const anomalousPage: LibraryListOutput = {
      items: [],
      nextCursor: null,
      hasMore: true,
    };
    assert.strictEqual(
      getNextPageParam(anomalousPage, [anomalousPage], undefined, []),
      undefined,
      'nextCursor 为 null 时必须返回 undefined'
    );

    // 2.2 queryFn 代理入参验证
    let capturedListInput: unknown = null;
    const origList = libraryClient.list;
    (libraryClient as { list: unknown }).list = async (input: unknown) => {
      capturedListInput = input;
      return { items: [], nextCursor: null, hasMore: false };
    };

    try {
      // 模拟调用 queryFn，传入 pageParam
      await (queryOpts.queryFn as (ctx: { pageParam?: string }) => Promise<unknown>)({
        pageParam: 'cursor_from_page_param',
      });

      assert.deepStrictEqual(
        capturedListInput,
        {
          view: 'active',
          query: 'test',
          cursor: 'cursor_from_page_param',
          limit: 20,
        },
        'queryFn 必须将 pageParam 映射为 cursor，并携带 view, query 与 limit=20'
      );
    } finally {
      (libraryClient as { list: unknown }).list = origList;
    }

    console.log('PASS: 2. Infinite Query 契约与 getNextPageParam 全边界断言通过');
  }

  console.log('=== 3. Detail Query 契约断言（queryKey 与 queryFn 委托）===');
  {
    const detailOpts = libraryDetailQueryOptions(108);
    assert.deepStrictEqual(detailOpts.queryKey, ['library', 'detail', 108]);

    let capturedGetInput: unknown = null;
    const origGet = libraryClient.get;
    (libraryClient as { get: unknown }).get = async (input: unknown) => {
      capturedGetInput = input;
      return {
        id: 108,
        title: 'Detail Work',
        excerpt: 'Excerpt',
        voiceId: 'voice_1',
        contentHash: 'hash123',
        favoritedAt: null,
        deletedAt: null,
        createdAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:00.000Z',
        prompt: 'Prompt text',
        storyText: 'Story body text',
        sourceMessageId: 'msg_001',
        audio: { status: 'missing', durationMs: null },
      };
    };

    try {
      const result = await (detailOpts.queryFn as () => Promise<unknown>)();
      assert.deepStrictEqual(capturedGetInput, { id: 108 }, 'queryFn 必须以 { id } 结构体调用 libraryClient.get');
      assert.strictEqual((result as { id: number }).id, 108);
    } finally {
      (libraryClient as { get: unknown }).get = origGet;
    }

    console.log('PASS: 3. Detail Query 契约断言通过');
  }

  console.log('=== 4. ViewModel 合成边界断言（M5 progress 缝隙与 M8 audio 结构保真）===');
  {
    const mockSummary: StoryWorkSummaryDTO = {
      id: 301,
      title: 'The Starlight Journey',
      excerpt: 'Once upon a time under the starlight...',
      voiceId: 'female-warm-1',
      contentHash: 'hash_abc_123',
      favoritedAt: '2026-09-12T10:00:00.000Z',
      deletedAt: null,
      createdAt: '2026-09-12T08:00:00.000Z',
      updatedAt: '2026-09-12T10:00:00.000Z',
      audio: {
        status: 'missing',
        durationMs: null,
      },
    };

    // 4.1 M3 缺省 progress 注入（恒为 null）
    const m3ViewModelDefault = composeLibraryItemViewModel(mockSummary);
    assert.strictEqual(m3ViewModelDefault.id, 301);
    assert.strictEqual(m3ViewModelDefault.title, 'The Starlight Journey');
    assert.strictEqual(m3ViewModelDefault.excerpt, 'Once upon a time under the starlight...');
    assert.strictEqual(m3ViewModelDefault.favoritedAt, '2026-09-12T10:00:00.000Z');
    assert.deepStrictEqual(
      m3ViewModelDefault.audio,
      { status: 'missing', durationMs: null },
      'audio 结构必须与 DTO 保持完全一致（M8 预留）'
    );
    assert.strictEqual(m3ViewModelDefault.progress, null, 'M3 缺省 progress 必须为 null');

    // 4.2 M3 显式 null 注入
    const m3ViewModelExplicitNull = composeLibraryItemViewModel(mockSummary, null);
    assert.strictEqual(m3ViewModelExplicitNull.progress, null);

    // 4.3 M5 仿真：外部注入 progress projection，ViewModel 形状与类型无缝兼容
    interface MockProgressProjection {
      paragraphIndex: number;
      audioPositionMs: number;
    }
    const injectedProgress: MockProgressProjection = {
      paragraphIndex: 3,
      audioPositionMs: 45000,
    };
    const m5ViewModel = composeLibraryItemViewModel(mockSummary, injectedProgress);
    assert.deepStrictEqual(
      m5ViewModel.progress,
      injectedProgress,
      '注入外部 progress 投影时必须完整保留该结构'
    );
    assert.strictEqual(m5ViewModel.id, 301, '身份字段不受注入影响');

    // 4.4 Detail ViewModel 合成
    const mockDetail: StoryWorkDetailDTO = {
      ...mockSummary,
      prompt: 'Write a bedtime story about the stars',
      storyText: 'Once upon a time under the starlight, a little fox looked up...',
      sourceMessageId: 'src_msg_777',
      audio: {
        status: 'ready',
        durationMs: 120000,
      },
    };

    const detailVm = composeLibraryDetailViewModel(mockDetail, null);
    assert.strictEqual(detailVm.id, 301);
    assert.strictEqual(detailVm.prompt, 'Write a bedtime story about the stars');
    assert.strictEqual(detailVm.storyText, mockDetail.storyText);
    assert.strictEqual(detailVm.sourceMessageId, 'src_msg_777');
    assert.deepStrictEqual(detailVm.audio, { status: 'ready', durationMs: 120000 });
    assert.strictEqual(detailVm.progress, null);

    // 4.5 批量合成助手函数
    const summary2: StoryWorkSummaryDTO = {
      ...mockSummary,
      id: 302,
      title: 'Second Story',
    };
    const batchVms = composeLibraryItemListViewModel([mockSummary, summary2], {
      301: injectedProgress,
    });
    assert.strictEqual(batchVms.length, 2);
    assert.deepStrictEqual(batchVms[0].progress, injectedProgress);
    assert.strictEqual(batchVms[1].progress, null);

    console.log('PASS: 4. ViewModel 合成边界断言通过');
  }

  console.log('=== 5. 静态守卫断言（源码扫描：严禁禁用 import 泄漏）===');
  {
    const repoRoot = process.cwd();
    const filesToScan = [
      path.join(repoRoot, 'lib/client/libraryQueries.ts'),
      path.join(repoRoot, 'lib/client/libraryViewModel.ts'),
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
      assert(fs.existsSync(filePath), `被扫描文件必须存在：${filePath}`);
      const content = fs.readFileSync(filePath, 'utf-8');

      for (const forbidden of forbiddenImports) {
        const importPattern = new RegExp(`['"]${forbidden}(/.*)?['"]`);
        assert(
          !importPattern.test(content),
          `静态守卫违背：文件 ${path.basename(filePath)} 不得导入禁用的模块 "${forbidden}"`
        );
      }
    }

    console.log('PASS: 5. 静态守卫断言通过（无 @/lib/trpc/client, @/lib/server/*, @prisma/*, @trpc/react-query 泄漏）');
  }

  console.log('ALL LIBRARY QUERY MODEL UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = runLibraryQueryModelUnitTests()
  .then(() => {
    console.log('ALL LIBRARY QUERY MODEL UNIT TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
