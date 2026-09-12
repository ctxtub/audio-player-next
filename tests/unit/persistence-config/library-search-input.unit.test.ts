import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  SearchParamsContext,
  PathnameContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

// 初始化 JSDOM 全局环境（供 React Hook 与 DOM 事件使用）
const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const { JSDOM } = nodeRequire('jsdom') as {
  JSDOM: new (html: string, opts?: Record<string, unknown>) => { window: Record<string, unknown> };
};

if (typeof window === 'undefined') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  try {
    Object.defineProperty(g, 'window', { value: win, writable: true, configurable: true });
  } catch {
    g.window = win;
  }
  try {
    Object.defineProperty(g, 'document', { value: win.document, writable: true, configurable: true });
  } catch {
    g.document = win.document;
  }
  try {
    Object.defineProperty(g, 'navigator', { value: win.navigator, writable: true, configurable: true });
  } catch {
    g.navigator = win.navigator;
  }
}

import {
  LibrarySearchController,
  SEARCH_DEBOUNCE_MS,
  type RouterLike,
} from '../../../lib/client/libraryFilters';
import { useLibraryFilters } from '../../../app/(main)/library/useLibraryFilters';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * M3-03: Library Search Input & IME State Machine 单元测试套件
 *
 * 核心验证：
 * 1. 300ms 防抖契约：300ms 前零调用；300ms 后恰好一次调用；
 * 2. 多次打字连续输入防抖抑制：仅最后一次输入在 300ms 后生效；
 * 3. 搜索词 canonical 规整：空格 trim 与纯空白移除 q；
 * 4. IME 组合状态锁：
 *    - compositionstart 立即挂起防抖，组合期间零调用；
 *    - compositionend 以最终值重新开始完整 300ms 计时，期满后仅调用一次；
 * 5. 纯控制器 Back/Forward 草稿同步与零历史污染；
 * 6. B2 冻结 300ms 签名回归：UseLibraryFiltersOptions 不允许 debounceMs override，内部固定 300ms；
 * 7. B1 Production Hook 生命周期回归（真实驱动 useLibraryFilters）：
 *    a) pending search -> Back 到不同 q/view -> 等超 300ms -> router 零调用 -> draft/view/q 同步为 Back 后 URL；
 *    b) 易漏版：pending search -> Back 只改变 view、q 不变 -> 等超 300ms -> 绝不触发 stale replace。
 */
async function runLibrarySearchInputUnitTests(): Promise<void> {
  console.log('=== 1. 300ms 防抖契约：300ms 前零调用，300ms 后恰好一次调用 ===');
  {
    assert.strictEqual(SEARCH_DEBOUNCE_MS, 300, 'SEARCH_DEBOUNCE_MS 契约固定为 300ms');

    const replacedUrls: string[] = [];
    const pushedUrls: string[] = [];
    const mockRouter: RouterLike = {
      push: (href) => pushedUrls.push(href),
      replace: (href) => replacedUrls.push(href),
    };

    const controller = new LibrarySearchController({
      initialUrl: '/library',
      router: mockRouter,
      debounceMs: 300,
    });

    // 用户输入 "hero"
    controller.setDraftQ('hero');
    assert.strictEqual(controller.getState().draftQ, 'hero');

    // 100ms: 尚未达到 300ms，必须零调用
    await sleep(100);
    assert.strictEqual(replacedUrls.length, 0, '100ms 时 router 必须零调用');
    assert.strictEqual(pushedUrls.length, 0);

    // 200ms: 尚未达到 300ms，必须零调用
    await sleep(100);
    assert.strictEqual(replacedUrls.length, 0, '200ms 时 router 必须零调用');

    // 满 350ms: 已超过 300ms，必须恰好调用一次 router.replace
    await sleep(150);
    assert.strictEqual(replacedUrls.length, 1, '300ms 到期后必须且仅调用一次 router.replace');
    assert.strictEqual(pushedUrls.length, 0, '搜索提交绝对不得使用 router.push');
    assert.strictEqual(replacedUrls[0], '/library?q=hero');
    assert.strictEqual(controller.getState().q, 'hero');

    controller.destroy();
    console.log('PASS: 1. 300ms 防抖计时与零调用断言通过');
  }

  console.log('=== 2. 连续快速输入：旧计时器重置，仅最后一次生效 ===');
  {
    const replacedUrls: string[] = [];
    const mockRouter: RouterLike = {
      push: () => {},
      replace: (href) => replacedUrls.push(href),
    };

    const controller = new LibrarySearchController({
      initialUrl: '/library',
      router: mockRouter,
      debounceMs: 300,
    });

    // t=0ms: 输入 'h'
    controller.setDraftQ('h');
    await sleep(100);

    // t=100ms: 输入 'he'
    controller.setDraftQ('he');
    await sleep(100);

    // t=200ms: 输入 'her'
    controller.setDraftQ('her');
    await sleep(100);

    // t=300ms: 输入 'hero'
    controller.setDraftQ('hero');
    assert.strictEqual(replacedUrls.length, 0, '在连续输入且间隔 <300ms 时必须零调用');

    // 满 350ms 之后
    await sleep(350);
    assert.strictEqual(replacedUrls.length, 1, '连续快速输入完成后，必须且仅提交一次最终内容');
    assert.strictEqual(replacedUrls[0], '/library?q=hero');

    controller.destroy();
    console.log('PASS: 2. 连续快速输入防抖重置断言通过');
  }

  console.log('=== 3. 搜索词 canonical 规整：空格 trim 与纯空白移除 q ===');
  {
    const replacedUrls: string[] = [];
    const mockRouter: RouterLike = {
      push: () => {},
      replace: (href) => replacedUrls.push(href),
    };

    const controller = new LibrarySearchController({
      initialUrl: '/library?q=old',
      router: mockRouter,
      debounceMs: 100, // 缩短微测试耗时
    });

    // 3.1 输入首尾带空格的 "  starlight  " -> canonical 为 "starlight"
    controller.setDraftQ('  starlight  ');
    await sleep(150);
    assert.strictEqual(replacedUrls.length, 1);
    assert.strictEqual(replacedUrls[0], '/library?q=starlight');
    assert.strictEqual(controller.getState().q, 'starlight');

    // 3.2 输入纯空白 "   " -> canonical 为 undefined，URL 移除 q
    controller.setDraftQ('   ');
    await sleep(150);
    assert.strictEqual(replacedUrls.length, 2);
    assert.strictEqual(replacedUrls[1], '/library', '搜索词为空白时必须移除 q，产出 /library');
    assert.strictEqual(controller.getState().q, undefined);

    // 3.3 再次输入与当前相同的空内容：不产生冗余调用
    controller.setDraftQ('');
    await sleep(150);
    assert.strictEqual(replacedUrls.length, 2, '相同 canonical 内容不产生冗余 router 调用');

    controller.destroy();
    console.log('PASS: 3. 搜索词 canonical 规整断言通过');
  }

  console.log('=== 4. IME 组合状态锁断言：组合期间零调用，结束后重新计时 ===');
  {
    const replacedUrls: string[] = [];
    const mockRouter: RouterLike = {
      push: () => {},
      replace: (href) => replacedUrls.push(href),
    };

    const controller = new LibrarySearchController({
      initialUrl: '/library',
      router: mockRouter,
      debounceMs: 200,
    });

    // 4.1 用户开始拼音输入（compositionstart）
    controller.onCompositionStart();
    assert.strictEqual(controller.getState().isComposing, true);

    // 在组合状态下输入中间码 'n'、'ni'、'nih'、'nihao'
    controller.setDraftQ('n');
    await sleep(100);
    controller.setDraftQ('ni');
    await sleep(100);
    controller.setDraftQ('nih');
    await sleep(150);
    controller.setDraftQ('nihao');
    await sleep(250); // 即使超过 200ms，只要处于 composing，必须零调用

    assert.strictEqual(
      replacedUrls.length,
      0,
      'IME 组合期间绝对禁止调用 router.replace，杜绝用未确认拼音查询'
    );

    // 4.2 用户选词确认（compositionend，最终值为 "你好"）
    controller.onCompositionEnd('你好');
    assert.strictEqual(controller.getState().isComposing, false);
    assert.strictEqual(controller.getState().draftQ, '你好');

    // 组合刚结束 100ms：尚未到 200ms，必须仍为 0 次调用
    await sleep(100);
    assert.strictEqual(
      replacedUrls.length,
      0,
      'compositionend 后重新开始防抖计时，未达 debounceMs 时零调用'
    );

    // 到期满 250ms 后：恰好一次调用，提交 "你好"
    await sleep(150);
    assert.strictEqual(replacedUrls.length, 1, 'compositionend 防抖期满后恰好调用一次');
    assert.strictEqual(replacedUrls[0], '/library?q=%E4%BD%A0%E5%A5%BD'); // encodeURIComponent("你好")
    assert.strictEqual(controller.getState().q, '你好');

    controller.destroy();
    console.log('PASS: 4. IME 组合状态锁与重新开始防抖断言通过');
  }

  console.log('=== 5. 纯控制器 Back/Forward 同步草稿，零历史污染 ===');
  {
    const replacedUrls: string[] = [];
    const pushedUrls: string[] = [];
    const mockRouter: RouterLike = {
      push: (href) => pushedUrls.push(href),
      replace: (href) => replacedUrls.push(href),
    };

    const controller = new LibrarySearchController({
      initialUrl: '/library?q=current',
      router: mockRouter,
    });

    assert.strictEqual(controller.getState().draftQ, 'current');

    // 用户在输入框乱写草稿（未触发防抖）
    controller.setDraftQ('pending_dirty_draft');

    // 此时浏览器发生 popstate（用户点击了 Back，回到 URL /library?view=favorites&q=previous）
    controller.syncFromUrl('/library?view=favorites&q=previous');

    assert.strictEqual(controller.getState().draftQ, 'previous', 'Back/Forward 时 input draft 必须重新与 URL 同步');
    assert.strictEqual(controller.getState().view, 'favorites');
    assert.strictEqual(controller.getState().q, 'previous');
    assert.strictEqual(pushedUrls.length, 0, 'Back/Forward 同步绝不产生 router.push');
    assert.strictEqual(replacedUrls.length, 0, 'Back/Forward 同步绝不产生 router.replace');

    // 再次后退至根路径 /library
    controller.syncFromUrl('/library');
    assert.strictEqual(controller.getState().draftQ, '', '后退至无 q 的 URL 时，草稿自动清空为 ""');
    assert.strictEqual(controller.getState().q, undefined);
    assert.strictEqual(controller.getState().view, 'active');
    assert.strictEqual(pushedUrls.length, 0);
    assert.strictEqual(replacedUrls.length, 0);

    controller.destroy();
    console.log('PASS: 5. 纯控制器 Back/Forward 草稿同步断言通过');
  }

  console.log('=== 6. B2 冻结 300ms 签名回归（UseLibraryFiltersOptions 绝无 debounceMs）===');
  {
    const hookSourcePath = path.join(process.cwd(), 'app/(main)/library/useLibraryFilters.ts');
    const hookSource = fs.readFileSync(hookSourcePath, 'utf-8');

    // 6.1 验证 UseLibraryFiltersOptions 仅包含 basePath，绝对无 debounceMs 字段
    assert.ok(
      /export\s+interface\s+UseLibraryFiltersOptions\s*\{\s*basePath\?:\s*string;\s*\}/.test(hookSource),
      'UseLibraryFiltersOptions 必须仅允许 basePath，严禁暴露 debounceMs'
    );
    assert.strictEqual(
      hookSource.includes('debounceMs?:'),
      false,
      'production hook 严禁声明可被外部改写的 debounceMs 配置'
    );

    // 6.2 验证内部恒定绑定 SEARCH_DEBOUNCE_MS
    assert.ok(
      /const\s+debounceMs\s*=\s*SEARCH_DEBOUNCE_MS/.test(hookSource),
      'production hook 内部必须恒定使用 SEARCH_DEBOUNCE_MS 冻结常量'
    );

    console.log('PASS: 6. B2 冻结 300ms 签名回归断言通过');
  }

  console.log('=== 7. B1 Production Hook 生命周期回归（真实驱动 useLibraryFilters）===');
  {
    // 7.1 Scenario A: pending search -> Back 到不同 q/view -> 等超 300ms -> router 零调用
    console.log('--- 7.1 Scenario A: pending search -> Back 到不同 q/view ---');
    {
      let currentSearchParams = new URLSearchParams('view=active&q=original');
      const replaces: string[] = [];
      const pushes: string[] = [];
      const mockRouter = {
        push: (href: string) => pushes.push(href),
        replace: (href: string) => replaces.push(href),
        prefetch: () => {},
        back: () => {},
        forward: () => {},
        refresh: () => {},
      };

      const wrapper = ({ children }: { children?: React.ReactNode }) =>
        React.createElement(
          AppRouterContext.Provider,
          { value: mockRouter as any },
          React.createElement(
            PathnameContext.Provider,
            { value: '/library' },
            React.createElement(
              SearchParamsContext.Provider,
              { value: currentSearchParams },
              children
            )
          )
        );

      const { result, rerender } = renderHook(() => useLibraryFilters(), { wrapper });
      assert.strictEqual(result.current.draftQ, 'original');
      assert.strictEqual(result.current.view, 'active');
      assert.strictEqual(result.current.q, 'original');

      // 用户输入草稿 'hero'（启动 300ms debounce timer）
      act(() => {
        result.current.setDraftQ('hero');
      });
      assert.strictEqual(result.current.draftQ, 'hero');
      assert.strictEqual(replaces.length, 0);

      // 100ms 时浏览器发生 Back，切到不同 q/view：/library?view=favorites&q=back_query
      await sleep(100);
      act(() => {
        currentSearchParams = new URLSearchParams('view=favorites&q=back_query');
        rerender();
      });

      // 验证草稿与 URL 立即同步
      assert.strictEqual(result.current.view, 'favorites');
      assert.strictEqual(result.current.q, 'back_query');
      assert.strictEqual(result.current.draftQ, 'back_query');

      // 等待超过 300ms（等待 400ms）
      await sleep(400);

      // 核心断言：旧 timer 必须被清除，replace 调用次数仍为 0，旧草稿绝不复活覆盖新 URL
      assert.strictEqual(replaces.length, 0, 'Scenario A: 旧 timer 必须被清除，router.replace 必须零调用');
      assert.strictEqual(pushes.length, 0);
      assert.strictEqual(result.current.view, 'favorites');
      assert.strictEqual(result.current.q, 'back_query');
      assert.strictEqual(result.current.draftQ, 'back_query');
      console.log('PASS: 7.1 Scenario A 通过');
    }

    // 7.2 Scenario B (易漏版): pending search -> Back 只改变 view、q 不变 -> 等超 300ms -> 不得发生 stale replace
    console.log('--- 7.2 Scenario B: pending search -> Back 只改变 view、q 不变 ---');
    {
      let currentSearchParams = new URLSearchParams('view=active&q=same_query');
      const replaces: string[] = [];
      const pushes: string[] = [];
      const mockRouter = {
        push: (href: string) => pushes.push(href),
        replace: (href: string) => replaces.push(href),
        prefetch: () => {},
        back: () => {},
        forward: () => {},
        refresh: () => {},
      };

      const wrapper = ({ children }: { children?: React.ReactNode }) =>
        React.createElement(
          AppRouterContext.Provider,
          { value: mockRouter as any },
          React.createElement(
            PathnameContext.Provider,
            { value: '/library' },
            React.createElement(
              SearchParamsContext.Provider,
              { value: currentSearchParams },
              children
            )
          )
        );

      const { result, rerender } = renderHook(() => useLibraryFilters(), { wrapper });
      assert.strictEqual(result.current.view, 'active');
      assert.strictEqual(result.current.q, 'same_query');
      assert.strictEqual(result.current.draftQ, 'same_query');

      // 用户输入草稿 'same_query_editing'（启动 300ms debounce timer）
      act(() => {
        result.current.setDraftQ('same_query_editing');
      });
      assert.strictEqual(result.current.draftQ, 'same_query_editing');
      assert.strictEqual(replaces.length, 0);

      // 100ms 时浏览器发生 Back：仅改变 view=trash，q 仍然是 'same_query'！
      await sleep(100);
      act(() => {
        currentSearchParams = new URLSearchParams('view=trash&q=same_query');
        rerender();
      });

      // 验证草稿与 view 立即同步为 Back 后的内容
      assert.strictEqual(result.current.view, 'trash');
      assert.strictEqual(result.current.q, 'same_query');
      assert.strictEqual(result.current.draftQ, 'same_query');

      // 等待超过 300ms（等待 400ms）
      await sleep(400);

      // 核心断言：绝对不得发生 stale replace！
      assert.strictEqual(
        replaces.length,
        0,
        'Scenario B: Back 仅改变 view 时旧 timer 必须被清除，不得发生 stale replace'
      );
      assert.strictEqual(pushes.length, 0);
      assert.strictEqual(result.current.view, 'trash');
      assert.strictEqual(result.current.q, 'same_query');
      assert.strictEqual(result.current.draftQ, 'same_query');
      console.log('PASS: 7.2 Scenario B 通过');
    }

    console.log('PASS: 7. B1 Production Hook 生命周期回归断言全部通过');
  }

  console.log('ALL LIBRARY SEARCH INPUT UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = runLibrarySearchInputUnitTests()
  .then(() => {
    console.log('ALL LIBRARY SEARCH INPUT UNIT TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
