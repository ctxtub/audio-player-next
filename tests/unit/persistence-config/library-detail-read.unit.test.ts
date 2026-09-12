/**
 * Library 故事作品详情读取与统一不可用语义单元测试 (M3-06)
 *
 * 核心验证范围：
 * 1) 统一不可用语义断言（NOT_FOUND / UNAUTHORIZED / foreign-owned / trashed / 不存在 / 非法ID → 渲染完全一致的 LibraryUnavailable，不可区分）
 * 2) 正常详情渲染断言（正文、摘要、提示词、音色、时间、音频信息等字段完整保真，来自 DTO）
 * 3) 零额外探测查询铁律断言（严禁调用 libraryClient.list 或 list({ view: 'trash' }) 进行侧信道探测）
 * 4) ViewModel 播放进度缝隙断言（VM seam progress 严格保持 null，为 M5 预留干净接入点）
 * 5) 四态覆盖断言（Loading 骨架态、Unavailable 统一态、Generic Error 重试态、Success 正常态）
 * 6) 静态纯只读与架构隔离守卫（绝无 Rename/Favorite/Trash 等变更泄漏、绝无 Server 依赖泄漏）
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
    win.cancelIdleCallback = (id: any) => clearTimeout(id);
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

const StoryDetailPage = innerJiti('./app/(main)/library/[id]/index.tsx').default;
const { StoryDetail } = innerJiti('./components/Library/StoryDetail.tsx');
const {
  LibraryUnavailable,
  isUnavailableError,
} = innerJiti('./components/Library/LibraryUnavailable.tsx');
const {
  composeLibraryDetailViewModel,
} = innerJiti('./lib/client/libraryViewModel.ts');
const { libraryKeys } = innerJiti('./lib/client/libraryQueries.ts');

function createMockDetailDTO(id: number, overrides: Record<string, any> = {}) {
  return {
    id,
    title: `测试故事作品 ${id}`,
    excerpt: `这是故事 ${id} 的精彩摘要，揭示冒险的开端。`,
    prompt: `请创作一篇关于故事 ${id} 的奇幻探险童话，富有哲理与想象力。`,
    storyText: `从前在遥远的魔法森林里，故事 ${id} 悄然展开。第一章：晨曦初现，微风轻拂...\n第二章：神秘钥匙出现...`,
    voiceId: 'zh-CN-YunxiNeural',
    contentHash: `hash-${id}-abcdef123456`,
    favoritedAt: null,
    deletedAt: null,
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:30:00.000Z',
    audio: {
      status: 'ready' as const,
      durationMs: 125000,
    },
    sourceMessageId: `msg-test-src-${id}`,
    ...overrides,
  };
}

async function runLibraryDetailReadUnitTests() {
  console.log('=== 1. 统一不可用语义与不可区分性断言（isUnavailableError 与 LibraryUnavailable）===');
  {
    // 1.1 纯函数 isUnavailableError 判定覆盖
    assert.strictEqual(isUnavailableError({ data: { code: 'NOT_FOUND' } }), true);
    assert.strictEqual(isUnavailableError({ shape: { code: 'NOT_FOUND' } }), true);
    assert.strictEqual(isUnavailableError({ code: 'NOT_FOUND' }), true);
    assert.strictEqual(isUnavailableError(new Error('NOT_FOUND')), true);
    assert.strictEqual(isUnavailableError(new Error('作品不存在')), true);
    assert.strictEqual(isUnavailableError({ data: { code: 'UNAUTHORIZED' } }), true);
    assert.strictEqual(isUnavailableError({ data: { httpStatus: 404 } }), true);
    assert.strictEqual(isUnavailableError({ data: { httpStatus: 401 } }), true);
    assert.strictEqual(isUnavailableError({ status: 404 }), true);
    assert.strictEqual(isUnavailableError({ status: 401 }), true);
    assert.strictEqual(isUnavailableError({ message: '404' }), true);
    assert.strictEqual(isUnavailableError({ message: '401' }), true);

    // 瞬态系统错误（500、网络超时等）绝不误判为不可用
    assert.strictEqual(isUnavailableError({ data: { code: 'INTERNAL_SERVER_ERROR' } }), false);
    assert.strictEqual(isUnavailableError(new Error('网络超时或数据库连接失败')), false);
    assert.strictEqual(isUnavailableError(null), false);
    assert.strictEqual(isUnavailableError(undefined), false);

    // 1.2 模拟 5 种不同场景下页面渲染结果（NOT_FOUND / UNAUTHORIZED / foreign / trashed / 不存在）
    const scenarios = [
      { name: 'NOT_FOUND 异常', error: new Error('NOT_FOUND: 作品不存在') },
      { name: 'UNAUTHORIZED 异常', error: { data: { code: 'UNAUTHORIZED' }, message: 'UNAUTHORIZED' } },
      { name: '跨主体他人作品（服务端返回 NOT_FOUND）', error: { data: { code: 'NOT_FOUND' } } },
      { name: '回收站作品（服务端返回 NOT_FOUND）', error: { data: { code: 'NOT_FOUND' } } },
      { name: '物理不存在的作品（服务端返回 404）', error: { status: 404, message: '404' } },
    ];

    const renderedHtmls: string[] = [];

    for (const scenario of scenarios) {
      cleanup();
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      const originalGet = innerJiti('./lib/client/library.ts').libraryClient.get;
      innerJiti('./lib/client/library.ts').libraryClient.get = async () => {
        throw scenario.error;
      };

      const { container } = render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(StoryDetailPage, { id: '999' })
        )
      );

      // 等待微任务完成
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });

      const unavailableCard = container.querySelector('[data-testid="library-unavailable"]');
      assert.ok(unavailableCard, `场景【${scenario.name}】必须渲染统一的 LibraryUnavailable 组件`);

      const backLink = container.querySelector('[data-testid="back-to-library-link"]');
      assert.ok(backLink, '必须提供返回故事库链接');
      assert.strictEqual(backLink.getAttribute('href'), '/library');

      // 提取纯净不可用卡片的文本与主要结构，证明不同原因产生完全相同无差别的 UI
      const cardHtml = unavailableCard.innerHTML;
      renderedHtmls.push(cardHtml);

      innerJiti('./lib/client/library.ts').libraryClient.get = originalGet;
      cleanup();
      queryClient.clear();
    }

    // 验证所有不可用原因渲染的卡片内容严格相同（不可区分性）
    const firstHtml = renderedHtmls[0];
    for (let i = 1; i < renderedHtmls.length; i++) {
      assert.strictEqual(
        renderedHtmls[i],
        firstHtml,
        `不可用场景【${scenarios[i].name}】与场景【${scenarios[0].name}】的不可用卡片内容必须绝对完全一致（杜绝侧信道泄漏）`
      );
    }

    // 1.3 非法 ID（0, -1, 非数字）直接渲染不可用视图，零网络 RPC
    {
      cleanup();
      let rpcCalled = false;
      const originalGet = innerJiti('./lib/client/library.ts').libraryClient.get;
      innerJiti('./lib/client/library.ts').libraryClient.get = async () => {
        rpcCalled = true;
        throw new Error('should not call');
      };

      const queryClient = new QueryClient();
      const { container } = render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(StoryDetailPage, { id: 'invalid-id' })
        )
      );

      assert.strictEqual(rpcCalled, false, '非法 ID 访问绝不能触发底层 RPC 查询');
      assert.ok(container.querySelector('[data-testid="library-unavailable"]'), '非法 ID 必须展示不可用组件');

      innerJiti('./lib/client/library.ts').libraryClient.get = originalGet;
      cleanup();
      queryClient.clear();
    }

    console.log('PASS: 1. 统一不可用语义与不可区分性断言全部通过');
  }

  console.log('=== 2. 正常详情渲染断言（字段完整保真，来自 DTO）===');
  {
    cleanup();
    const mockDTO = createMockDetailDTO(101, {
      title: '奇幻魔法森林大冒险',
      excerpt: '小狐狸在清晨找到了一把刻有古老符文的金色钥匙。',
      prompt: '请写一篇充满魔法与温情的儿童童话故事。',
      storyText: '第一章：金色钥匙。\n在浓雾散去的清晨，小狐狸踏上了寻梦之旅...',
      voiceId: 'zh-CN-YunxiNeural',
      contentHash: 'hash-abc1234567890',
      favoritedAt: '2026-09-12T15:00:00.000Z',
      createdAt: '2026-09-12T10:00:00.000Z',
      updatedAt: '2026-09-12T11:00:00.000Z',
      audio: {
        status: 'ready',
        durationMs: 135000,
      },
      sourceMessageId: 'msg-source-xyz-999',
    });

    const queryClient = new QueryClient();
    queryClient.setQueryData(libraryKeys.detail(101), mockDTO);

    const { container } = render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(StoryDetailPage, { id: '101' })
      )
    );

    // 2.1 容器与基本身份
    const detailContainer = container.querySelector('[data-testid="story-detail-container"]');
    assert.ok(detailContainer, '必须渲染详情根容器');
    assert.strictEqual(detailContainer.getAttribute('data-work-id'), '101');

    const idBadge = container.querySelector('[data-testid="story-detail-id"]');
    assert.ok(idBadge);
    assert.strictEqual(idBadge.textContent?.trim(), '#101');

    // 2.2 标题与收藏标签
    const titleEl = container.querySelector('[data-testid="story-detail-title"]');
    assert.strictEqual(titleEl?.textContent?.trim(), '奇幻魔法森林大冒险');

    const favoriteBadge = container.querySelector('[data-testid="story-detail-favorite-badge"]');
    assert.ok(favoriteBadge, '已收藏作品必须渲染收藏标识');
    assert.ok(favoriteBadge.textContent?.includes('已收藏'));

    // 2.3 元数据标签组
    const createdAtEl = container.querySelector('[data-testid="story-detail-created-at"]');
    assert.ok(createdAtEl?.textContent?.includes('创建于'));

    const voiceEl = container.querySelector('[data-testid="story-detail-voice"]');
    assert.ok(voiceEl?.textContent?.includes('zh-CN-YunxiNeural'));

    const audioStatusEl = container.querySelector('[data-testid="story-detail-audio-status"]');
    assert.ok(audioStatusEl?.textContent?.includes('ready'));
    assert.ok(audioStatusEl?.textContent?.includes('2:15')); // 135000ms = 2m 15s

    const hashEl = container.querySelector('[data-testid="story-detail-hash"]');
    assert.ok(hashEl?.textContent?.includes('hash-abc12'));

    // 2.4 导读与正文
    const excerptEl = container.querySelector('[data-testid="story-detail-excerpt"]');
    assert.ok(excerptEl?.textContent?.includes('小狐狸在清晨找到了一把刻有古老符文的金色钥匙。'));

    const textEl = container.querySelector('[data-testid="story-detail-text"]');
    assert.ok(textEl?.textContent?.includes('第一章：金色钥匙。'));
    assert.ok(textEl?.textContent?.includes('小狐狸踏上了寻梦之旅'));

    // 2.5 创作提示词与来源消息追踪
    const promptEl = container.querySelector('[data-testid="story-detail-prompt"]');
    assert.strictEqual(promptEl?.textContent?.trim(), '请写一篇充满魔法与温情的儿童童话故事。');

    const srcMsgEl = container.querySelector('[data-testid="story-detail-source-message"]');
    assert.ok(srcMsgEl?.textContent?.includes('msg-source-xyz-999'));

    cleanup();
    queryClient.clear();
    console.log('PASS: 2. 正常详情渲染断言全部通过（字段完整保真，来自 DTO）');
  }

  console.log('=== 3. 零额外探测查询铁律断言（严禁调用 list 或 list({ view: "trash" })）===');
  {
    cleanup();
    let listCallCount = 0;
    const originalList = innerJiti('./lib/client/library.ts').libraryClient.list;
    const originalGet = innerJiti('./lib/client/library.ts').libraryClient.get;

    innerJiti('./lib/client/library.ts').libraryClient.list = async () => {
      listCallCount++;
      return { items: [], nextCursor: null, hasMore: false };
    };

    // 场景 A：正常详情加载
    innerJiti('./lib/client/library.ts').libraryClient.get = async ({ id }: any) => {
      return createMockDetailDTO(id);
    };

    const queryClient = new QueryClient();
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(StoryDetailPage, { id: '201' })
      )
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    assert.strictEqual(
      listCallCount,
      0,
      '加载详情页时严格禁止调用 libraryClient.list（绝对零探测查询！）'
    );

    // 场景 B：报错 unavailable 发生时，绝不调用 list 探测是否在回收站中
    innerJiti('./lib/client/library.ts').libraryClient.get = async () => {
      throw new Error('NOT_FOUND');
    };

    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(StoryDetailPage, { id: '202' })
      )
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    assert.strictEqual(
      listCallCount,
      0,
      '作品发生 NOT_FOUND 时严格禁止发起 list({ view: "trash" }) 等侧信道探测查询！'
    );

    // 源码级扫描断言：StoryDetail 与 index.tsx 严禁出现 list 探测调用
    const filesToCheck = [
      path.join(repoRoot, 'app/(main)/library/[id]/index.tsx'),
      path.join(repoRoot, 'components/Library/StoryDetail.tsx'),
      path.join(repoRoot, 'components/Library/LibraryUnavailable.tsx'),
    ];

    for (const f of filesToCheck) {
      const code = fs.readFileSync(f, 'utf-8');
      assert.strictEqual(
        code.includes("view: 'trash'") || code.includes('view:"trash"'),
        false,
        `文件 ${path.basename(f)} 严禁包含针对 trash 视图的探测代码`
      );
      assert.strictEqual(
        code.includes('libraryClient.list') || code.includes('useLibraryListInfiniteQuery'),
        false,
        `文件 ${path.basename(f)} 严禁调用列表查询进行探测`
      );
    }

    innerJiti('./lib/client/library.ts').libraryClient.list = originalList;
    innerJiti('./lib/client/library.ts').libraryClient.get = originalGet;
    cleanup();
    queryClient.clear();
    console.log('PASS: 3. 零额外探测查询铁律断言全部通过（调用级与源码级严格零探测）');
  }

  console.log('=== 4. ViewModel 播放进度缝隙断言（VM seam progress 严格保持 null）===');
  {
    const mockDTO = createMockDetailDTO(301);

    // 4.1 composeLibraryDetailViewModel 默认合成
    const vmDefault = composeLibraryDetailViewModel(mockDTO);
    assert.strictEqual(vmDefault.progress, null, '未传入进度时，ViewModel 的 progress 必须严格为 null');
    assert.strictEqual(vmDefault.id, 301);
    assert.strictEqual(vmDefault.title, mockDTO.title);

    // 4.2 显式传入 null
    const vmExplicitNull = composeLibraryDetailViewModel(mockDTO, null);
    assert.strictEqual(vmExplicitNull.progress, null, '显式传入 null 时 progress 为 null');

    // 4.3 渲染组件验证 DOM 属性标记
    cleanup();
    const queryClient = new QueryClient();
    queryClient.setQueryData(libraryKeys.detail(301), mockDTO);

    const { container } = render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(StoryDetailPage, { id: '301' })
      )
    );

    const detailContainer = container.querySelector('[data-testid="story-detail-container"]');
    assert.ok(detailContainer);
    assert.strictEqual(
      detailContainer.getAttribute('data-has-progress'),
      'false',
      'M3 阶段 DOM 标记必须表明当前无播放进度注入（progress 为 null）'
    );

    cleanup();
    queryClient.clear();
    console.log('PASS: 4. ViewModel 播放进度缝隙断言全部通过（progress 严格保持 null）');
  }

  console.log('=== 5. 四态生命周期状态覆盖断言（Loading / Unavailable / Error / Success）===');
  {
    // 5.1 Loading 状态断言
    cleanup();
    const queryClientLoading = new QueryClient();
    let resolveGet!: (v: any) => void;
    const pendingPromise = new Promise((resolve) => {
      resolveGet = resolve;
    });

    const originalGet = innerJiti('./lib/client/library.ts').libraryClient.get;
    innerJiti('./lib/client/library.ts').libraryClient.get = async () => {
      return pendingPromise;
    };

    const { container: loadingContainer } = render(
      React.createElement(
        QueryClientProvider,
        { client: queryClientLoading },
        React.createElement(StoryDetailPage, { id: '501' })
      )
    );

    assert.ok(
      loadingContainer.querySelector('[data-testid="story-detail-loading"]'),
      '在请求 pending 期间必须渲染 Loading 骨架态'
    );

    // 5.2 Generic Error 状态断言与重试
    cleanup();
    let retryAttempt = 0;
    innerJiti('./lib/client/library.ts').libraryClient.get = async ({ id }: any) => {
      retryAttempt++;
      if (retryAttempt === 1) {
        throw new Error('网络断开，HTTP 500 服务端内部异常');
      }
      return createMockDetailDTO(id);
    };

    const queryClientError = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { container: errorContainer } = render(
      React.createElement(
        QueryClientProvider,
        { client: queryClientError },
        React.createElement(StoryDetailPage, { id: '502' })
      )
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const errorBlock = errorContainer.querySelector('[data-testid="story-detail-error"]');
    assert.ok(errorBlock, '非不可用的系统级错误必须渲染 Generic Error 重试界面');

    const retryBtn = errorContainer.querySelector(
      '[data-testid="story-detail-retry-btn"]'
    ) as HTMLButtonElement;
    assert.ok(retryBtn, '必须提供重试按钮');

    // 点击重试，第 2 次成功返回正常详情
    await act(async () => {
      fireEvent.click(retryBtn);
      await new Promise((r) => setTimeout(r, 20));
    });

    assert.strictEqual(retryAttempt, 2, '点击重试应再次发起 RPC 请求');
    assert.ok(
      errorContainer.querySelector('[data-testid="story-detail-container"]'),
      '重试成功后应正确展示正常故事详情'
    );

    innerJiti('./lib/client/library.ts').libraryClient.get = originalGet;
    cleanup();
    console.log('PASS: 5. 四态生命周期状态覆盖断言全部通过（Loading/Unavailable/Error/Success）');
  }

  console.log('=== 6. 静态纯只读与架构隔离守卫（No Mutations / No Client Leak）===');
  {
    const filesToScan = [
      path.join(repoRoot, 'app/(main)/library/[id]/page.tsx'),
      path.join(repoRoot, 'app/(main)/library/[id]/index.tsx'),
      path.join(repoRoot, 'components/Library/StoryDetail.tsx'),
      path.join(repoRoot, 'components/Library/LibraryUnavailable.tsx'),
    ];

    const forbiddenMutationKeywords = [
      'mutateRename',
      'mutateMoveToTrash',
      'mutateRestore',
      'mutateDeletePermanently',
      'useLibraryMutations',
      'deletePermanently',
      'libraryStore',
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
      assert.ok(fs.existsSync(filePath), `文件必须存在：${filePath}`);
      const content = fs.readFileSync(filePath, 'utf-8');

      // 6.1 严禁包含 Mutation 关键字（纯只读契约）
      for (const kw of forbiddenMutationKeywords) {
        assert.strictEqual(
          content.includes(kw),
          false,
          `静态守卫违背：文件 ${path.basename(filePath)} 不得包含 Mutation 变更标识 "${kw}"（M3-06 严格为纯只读）`
        );
      }

      // 6.2 严禁导入禁用模块
      for (const forbidden of forbiddenImports) {
        const importPattern = new RegExp(`['"]${forbidden}(/.*)?['"]`);
        assert.strictEqual(
          importPattern.test(content),
          false,
          `静态守卫违背：文件 ${path.basename(filePath)} 不得导入禁用的模块 "${forbidden}"`
        );
      }

      // 6.3 严禁越权读取内部表或内部模型
      const internalLeakPatterns = [
        'GenerationHistory',
        'generationHistory',
        'PlaybackProgress',
        'playbackProgress',
      ];
      for (const leak of internalLeakPatterns) {
        assert.strictEqual(
          content.includes(leak),
          false,
          `静态守卫违背：文件 ${path.basename(filePath)} 不得直接读取内部历史或播放状态 "${leak}"`
        );
      }
    }

    console.log('PASS: 6. 静态纯只读与架构隔离守卫断言全部通过');
  }

  console.log('ALL LIBRARY DETAIL READ UNIT TESTS PASSED SUCCESSFULLY');
}

runLibraryDetailReadUnitTests().catch((err) => {
  console.error('LIBRARY DETAIL READ UNIT TEST FAILED:', err);
  process.exit(1);
});
