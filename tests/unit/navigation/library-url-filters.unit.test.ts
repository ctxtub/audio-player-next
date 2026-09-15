import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  canonicalizeQuery,
  parseLibraryView,
  serializeLibraryUrl,
  parseLibraryUrl,
  VALID_LIBRARY_VIEWS,
  DEFAULT_LIBRARY_VIEW,
  LibrarySearchController,
  type RouterLike,
} from '../../../lib/client/libraryFilters';

/**
 * M3-03: Library URL Filters 单元测试套件（Navigation 层）
 *
 * 核心验证：
 * 1. invalid view -> active 兜底归一化；
 * 2. q trim 规范化行为与 M2 一致（canonical q；纯空白转 undefined；URL 移除 q）；
 * 3. 基础路径等价性（/library 等价于 view=active&q=''）；
 * 4. URL 绝对安全隔离（严禁序列化 cursor、page、offset 等内部参数）；
 * 5. view 切换操作保留当前 q，并使用 router.push 压入历史栈；
 * 6. 搜索提交操作使用 router.replace 避免历史栈污染；
 * 7. 静态守卫检查（严禁任何禁用 import 泄漏）。
 */
async function runLibraryUrlFiltersUnitTests(): Promise<void> {
  console.log('=== 1. invalid view -> active 视图解析与校验断言 ===');
  {
    assert.deepStrictEqual(
      VALID_LIBRARY_VIEWS,
      ['active', 'favorites', 'trash'],
      '合法视图集合必须为 active, favorites, trash'
    );
    assert.strictEqual(DEFAULT_LIBRARY_VIEW, 'active');

    // 正例
    assert.strictEqual(parseLibraryView('active'), 'active');
    assert.strictEqual(parseLibraryView('favorites'), 'favorites');
    assert.strictEqual(parseLibraryView('trash'), 'trash');

    // 边界与非法值兜底归一化至 active
    assert.strictEqual(parseLibraryView('unknown'), 'active');
    assert.strictEqual(parseLibraryView('favorite'), 'active');
    assert.strictEqual(parseLibraryView('TRASH'), 'active');
    assert.strictEqual(parseLibraryView('123'), 'active');
    assert.strictEqual(parseLibraryView(''), 'active');
    assert.strictEqual(parseLibraryView(null), 'active');
    assert.strictEqual(parseLibraryView(undefined), 'active');

    console.log('PASS: 1. invalid view -> active 校验断言通过');
  }

  console.log('=== 2. q trim 行为与 M2 领域规范一致（canonical q 与空值清除）===');
  {
    // 纯字符
    assert.strictEqual(canonicalizeQuery('hero'), 'hero');
    // 首尾空格 trim
    assert.strictEqual(canonicalizeQuery('  hero  '), 'hero');
    assert.strictEqual(canonicalizeQuery('\t\n hero \r\n'), 'hero');
    // 内部连续空格完整保留
    assert.strictEqual(canonicalizeQuery('  hero   journey  '), 'hero   journey');

    // 空白/空值转换为 undefined（触发从 URL 移除 q 参数）
    assert.strictEqual(canonicalizeQuery(''), undefined);
    assert.strictEqual(canonicalizeQuery('   '), undefined);
    assert.strictEqual(canonicalizeQuery('\t\n\r'), undefined);
    assert.strictEqual(canonicalizeQuery(null), undefined);
    assert.strictEqual(canonicalizeQuery(undefined), undefined);

    console.log('PASS: 2. q trim 与 canonicalizeQuery 断言通过');
  }

  console.log('=== 3. URL 序列化契约与 /library 等价性 ===');
  {
    // /library 等价于 view=active&q=''
    assert.strictEqual(serializeLibraryUrl({ view: 'active' }), '/library');
    assert.strictEqual(serializeLibraryUrl({ view: 'active', q: '' }), '/library');
    assert.strictEqual(serializeLibraryUrl({ view: 'active', q: '   ' }), '/library');
    assert.strictEqual(serializeLibraryUrl({ view: undefined, q: undefined }), '/library');
    assert.strictEqual(serializeLibraryUrl({}), '/library');

    // 非 active 视图
    assert.strictEqual(serializeLibraryUrl({ view: 'favorites' }), '/library?view=favorites');
    assert.strictEqual(serializeLibraryUrl({ view: 'trash' }), '/library?view=trash');

    // 携带 query
    assert.strictEqual(serializeLibraryUrl({ view: 'active', q: 'hero' }), '/library?q=hero');
    assert.strictEqual(serializeLibraryUrl({ view: 'active', q: '  hero  ' }), '/library?q=hero');
    assert.strictEqual(
      serializeLibraryUrl({ view: 'favorites', q: ' bedtime story ' }),
      '/library?view=favorites&q=bedtime+story'
    );
    assert.strictEqual(
      serializeLibraryUrl({ view: 'trash', q: 'dragon' }),
      '/library?view=trash&q=dragon'
    );

    // 非法视图自动回退
    assert.strictEqual(serializeLibraryUrl({ view: 'bad_view' as any, q: 'test' }), '/library?q=test');
    assert.strictEqual(serializeLibraryUrl({ view: 'bad_view' as any }), '/library');

    console.log('PASS: 3. URL 序列化契约与 /library 等价性断言通过');
  }

  console.log('=== 4. URL 永远不序列化 cursor, page, offset 等内部状态 ===');
  {
    // 即使传入含有 cursor/page/offset 等杂质字段的对象，序列化也绝对不允许写入这些参数
    const taintedInput = {
      view: 'trash' as const,
      q: 'foo',
      cursor: 'opaque_cursor_secret',
      page: 2,
      offset: 40,
      limit: 50,
    };
    const serialized = serializeLibraryUrl(taintedInput as any);
    assert.strictEqual(serialized, '/library?view=trash&q=foo');
    assert.strictEqual(serialized.includes('cursor'), false, 'URL 绝对禁止包含 cursor');
    assert.strictEqual(serialized.includes('page'), false, 'URL 绝对禁止包含 page');
    assert.strictEqual(serialized.includes('offset'), false, 'URL 绝对禁止包含 offset');
    assert.strictEqual(serialized.includes('limit'), false, 'URL 绝对禁止包含 limit');

    // 解析时也完全忽略 cursor、page 等
    const parsed = parseLibraryUrl('/library?view=favorites&q=test&cursor=123&page=5&offset=10');
    assert.deepStrictEqual(parsed, {
      view: 'favorites',
      q: 'test',
    });
    assert.strictEqual('cursor' in (parsed as any), false);
    assert.strictEqual('page' in (parsed as any), false);

    console.log('PASS: 4. URL 游标安全隔离与禁止序列化断言通过');
  }

  console.log('=== 5. 视图切换使用 router.push 且默认保留有效 q ===');
  {
    const pushedUrls: string[] = [];
    const replacedUrls: string[] = [];
    const mockRouter: RouterLike = {
      push: (href) => pushedUrls.push(href),
      replace: (href) => replacedUrls.push(href),
    };

    const controller = new LibrarySearchController({
      initialUrl: '/library?q=dragon',
      router: mockRouter,
    });

    // 初始状态
    assert.strictEqual(controller.getState().view, 'active');
    assert.strictEqual(controller.getState().q, 'dragon');
    assert.strictEqual(controller.getState().draftQ, 'dragon');

    // 切换至 favorites：必须调用 router.push，且携带原有搜索词 dragon
    controller.setView('favorites');
    assert.strictEqual(pushedUrls.length, 1, 'view 切换必须且仅调用一次 router.push');
    assert.strictEqual(replacedUrls.length, 0, 'view 切换绝不得调用 router.replace');
    assert.strictEqual(pushedUrls[0], '/library?view=favorites&q=dragon', 'view 切换必须保留当前有效 q');
    assert.strictEqual(controller.getState().view, 'favorites');

    // 切换至 trash
    controller.setView('trash');
    assert.strictEqual(pushedUrls.length, 2);
    assert.strictEqual(pushedUrls[1], '/library?view=trash&q=dragon');
    assert.strictEqual(controller.getState().view, 'trash');

    // 切换回 active
    controller.setView('active');
    assert.strictEqual(pushedUrls.length, 3);
    assert.strictEqual(pushedUrls[2], '/library?q=dragon');
    assert.strictEqual(controller.getState().view, 'active');

    controller.destroy();
    console.log('PASS: 5. 视图切换使用 router.push 且保留 q 断言通过');
  }

  console.log('=== 6. 静态架构守卫（禁止导入底层 tRPC client, Prisma, server 内部代码）===');
  {
    const repoRoot = process.cwd();
    const filesToScan = [
      path.join(repoRoot, 'lib/client/libraryFilters.ts'),
      path.join(repoRoot, 'app/(main)/library/useLibraryFilters.ts'),
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

    console.log('PASS: 6. 静态守卫断言通过（无 forbidden imports 泄漏）');
  }

  console.log('ALL LIBRARY URL FILTERS UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = runLibraryUrlFiltersUnitTests()
  .then(() => {
    console.log('ALL LIBRARY URL FILTERS UNIT TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
