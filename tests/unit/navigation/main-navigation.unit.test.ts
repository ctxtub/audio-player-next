import assert from 'node:assert';
import {
  DEFAULT_MAIN_TAB_KEY,
  MAIN_TABS,
  isRouteFamily,
  resolveMainTabKey,
} from '../../../lib/navigation/mainNavigation';

/**
 * 一级主导航路由契约单元测试（M1-01，L1）。
 * 验证：
 * 1. 核心验收条件（/chat, /chat/**, /library, /library/**, /player, /setting, /setting/**, /library-old）。
 * 2. isRouteFamily 边界控制（exact + '/' boundary 防前缀污染）。
 * 3. /player 过渡期 compatibility active alias 行为。
 * 4. unknown 路由与根路径的防御性 fallback。
 * 5. 查询参数与 Hash 容错处理。
 * 6. MAIN_TABS 元数据完整性。
 */
async function runMainNavigationTests(): Promise<void> {
  console.log('=== 1. 核心验收条件客观断言 ===');
  assert.strictEqual(resolveMainTabKey('/chat'), 'chat', "resolveMainTabKey('/chat') 必须为 'chat'");
  assert.strictEqual(resolveMainTabKey('/chat/foo'), 'chat', "resolveMainTabKey('/chat/foo') 必须为 'chat'");
  assert.strictEqual(resolveMainTabKey('/library'), 'library', "resolveMainTabKey('/library') 必须为 'library'");
  assert.strictEqual(resolveMainTabKey('/library/123'), 'library', "resolveMainTabKey('/library/123') 必须为 'library'");
  assert.notStrictEqual(resolveMainTabKey('/library-old'), 'library', "resolveMainTabKey('/library-old') 绝对不得为 'library'");
  assert.strictEqual(resolveMainTabKey('/player'), 'library', "resolveMainTabKey('/player') 必须映射为 'library'（compatibility alias）");
  assert.strictEqual(resolveMainTabKey('/setting'), 'setting', "resolveMainTabKey('/setting') 必须为 'setting'");
  assert.strictEqual(resolveMainTabKey('/setting/foo'), 'setting', "resolveMainTabKey('/setting/foo') 必须为 'setting'");
  console.log('PASS: 核心验收断言全部通过');

  console.log('=== 2. isRouteFamily 边界断言 (exact + / boundary) ===');
  // 精确匹配
  assert.strictEqual(isRouteFamily('/chat', '/chat'), true);
  assert.strictEqual(isRouteFamily('/library', '/library'), true);
  assert.strictEqual(isRouteFamily('/setting', '/setting'), true);

  // 子路径匹配
  assert.strictEqual(isRouteFamily('/chat/123', '/chat'), true);
  assert.strictEqual(isRouteFamily('/library/123/edit', '/library'), true);
  assert.strictEqual(isRouteFamily('/setting/account/security', '/setting'), true);

  // 末尾斜杠容错
  assert.strictEqual(isRouteFamily('/chat/', '/chat'), true);
  assert.strictEqual(isRouteFamily('/library/', '/library'), true);

  // 非法前缀碰撞排查（关键防御）
  assert.strictEqual(isRouteFamily('/library-old', '/library'), false, '/library-old 必须不归属 /library 家族');
  assert.strictEqual(isRouteFamily('/librarySomething', '/library'), false, '/librarySomething 必须不归属 /library 家族');
  assert.strictEqual(isRouteFamily('/chat-legacy', '/chat'), false, '/chat-legacy 必须不归属 /chat 家族');
  assert.strictEqual(isRouteFamily('/setting-v2', '/setting'), false, '/setting-v2 必须不归属 /setting 家族');

  // 空值与非前缀断言
  assert.strictEqual(isRouteFamily('', '/chat'), false);
  assert.strictEqual(isRouteFamily('/other', '/chat'), false);
  console.log('PASS: isRouteFamily 边界断言全部通过');

  console.log('=== 3. /player 过渡期 active Tab 映射 ===');
  assert.strictEqual(resolveMainTabKey('/player'), 'library');
  assert.strictEqual(resolveMainTabKey('/player/'), 'library');
  assert.notStrictEqual(resolveMainTabKey('/player-old'), 'library');
  assert.strictEqual(resolveMainTabKey('/player-old'), 'chat', '/player-old 必须作为未知路由回退到 chat');
  console.log('PASS: /player compatibility 映射通过');

  console.log('=== 4. 未知路径与异常入参防御性 fallback 到 chat ===');
  assert.strictEqual(resolveMainTabKey('/'), DEFAULT_MAIN_TAB_KEY);
  assert.strictEqual(resolveMainTabKey('/unknown-route'), 'chat');
  assert.strictEqual(resolveMainTabKey('/404'), 'chat');
  assert.strictEqual(resolveMainTabKey(''), 'chat');
  assert.strictEqual(resolveMainTabKey(null), 'chat');
  assert.strictEqual(resolveMainTabKey(undefined), 'chat');
  console.log('PASS: 未知路径与异常入参回退通过');

  console.log('=== 5. 查询参数与 Hash 容错处理 ===');
  assert.strictEqual(resolveMainTabKey('/chat?session=123'), 'chat');
  assert.strictEqual(resolveMainTabKey('/library?tab=all'), 'library');
  assert.strictEqual(resolveMainTabKey('/library/123?sort=desc#review'), 'library');
  assert.strictEqual(resolveMainTabKey('/player?audioId=abc'), 'library');
  assert.strictEqual(resolveMainTabKey('/setting?theme=dark'), 'setting');
  console.log('PASS: 查询参数与 Hash 容错处理通过');

  console.log('=== 6. MAIN_TABS 配置完整性断言 ===');
  assert.strictEqual(MAIN_TABS.length, 3, 'MAIN_TABS 必须包含 3 个一级导航项');
  assert.deepStrictEqual(
    MAIN_TABS.map(t => t.key),
    ['chat', 'library', 'setting'],
    'MAIN_TABS keys 必须为 [chat, library, setting]',
  );
  assert.deepStrictEqual(
    MAIN_TABS.map(t => t.title),
    ['创作', '故事库', '设置'],
    'MAIN_TABS 标题必须符合产品契约 [创作, 故事库, 设置]',
  );
  assert.deepStrictEqual(
    MAIN_TABS.map(t => t.path),
    ['/chat', '/library', '/setting'],
    'MAIN_TABS 基础路径必须为 [/chat, /library, /setting]',
  );
  console.log('PASS: MAIN_TABS 配置完整性通过');
}

const testPromise = runMainNavigationTests()
  .then(() => {
    console.log('\nALL MAIN NAVIGATION UNIT TEST CASES PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;
