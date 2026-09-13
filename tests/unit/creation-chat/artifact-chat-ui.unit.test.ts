import assert from 'node:assert';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';

// 中文注释：M4-05 Artifact Chat UI / Promotion State Surface 回归（E2E-08-05）。
// StoryArtifactPart 从“带 playback 预接的 generation 卡片”变为“纯 ChatArtifact lifecycle UI”：
// 六态可表达（M4-05-01）、正文归 Artifact 所有（M4-05-02）、complete≠saved（M4-05-03）、
// promoting 面（M4-05-04）、ready→Library handoff（M4-05-05）、失败保留正文（M4-05-06）、
// retry 唯一动作（M4-05-07）、双击 exactly-one（M4-05-08）、interrupted 分家（M4-05-09）、
// Modern 播放纯净度（M4-05-10）、Legacy 只读兼容（M4-05-11）、架构纯净度（M4-05-12）。
// 全程内存渲染（jsdom + 真实组件 + 真实 chatStore），不建 socket、不绑端口，不碰 prisma/dev.db。

// 中文注释：NodeRequire 兼容取值（jiti 运行器下 require 可能未全局暴露）。
const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
// 中文注释：jsdom 最小形态（无 @types/jsdom，经 require 加载，避免新增类型依赖）。
type JSDOMWindowLike = Record<string, unknown>;
type JSDOMLike = { window: JSDOMWindowLike };
type JSDOMCtorLike = new (html: string, opts?: Record<string, unknown>) => JSDOMLike;
// 中文注释：仓库根目录，用于 inner-jiti 的 alias 解析。
const repoRoot: string = process.cwd();
// 中文注释：inner-jiti 实例与工厂类型（解析真实 .tsx 组件，需 jsx:true）。
type JitiInstance = (id: string) => Record<string, unknown>;
type JitiFactory = (base: string, opts: Record<string, unknown>) => JitiInstance;
// 中文注释：chatStore 最小形态（仅本测试用到的字段与动作）。
type ChatStoreLike = {
  getState: () => {
    messages: Array<{
      id: string;
      role: string;
      content: string;
      parts?: Array<{ type: string; artifact?: Record<string, unknown> }>;
      status?: string;
    }>;
    dispatch: (action: unknown) => void;
    reset: () => void;
  };
  setState: (p: Record<string, unknown>) => void;
};

/**
 * 安装样式与静态资源内存桩（仅拦截样式/图片后缀，不触业务逻辑）。
 */
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
        },
      );
      (m as unknown as { exports: unknown }).exports = proxy;
    };
    extTable['.scss'] = scssStub as (m: NodeModule, f: string) => void;
    extTable['.css'] = scssStub as (m: NodeModule, f: string) => void;
  }
  if (extTable) {
    for (const ext of ['.jpeg', '.jpg', '.png', '.svg', '.webp', '.gif', '.avif', '.ico']) {
      if (!extTable[ext]) {
        extTable[ext] = ((m: NodeModule, f: string): void => {
          const mockImage = { src: f, width: 64, height: 64 };
          (m as unknown as { exports: unknown }).exports = mockImage;
        }) as (m: NodeModule, f: string) => void;
      }
    }
  }
}

/**
 * 搭建 jsdom 完整全局（含 react-aria 所需的 NodeFilter/SVGElement 等）。
 * @returns jsdom 实例。
 */
function setupJsdom(): JSDOMLike {
  const { JSDOM } = nodeRequire('jsdom') as unknown as { JSDOM: JSDOMCtorLike };
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  const copyKeys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLTextAreaElement',
    'HTMLInputElement',
    'HTMLButtonElement',
    'HTMLAnchorElement',
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
    'localStorage',
    'React',
  ];
  const winAsRec = win as Record<string, unknown>;
  try {
    Object.defineProperty(g, 'window', { value: win, writable: true, configurable: true });
  } catch {
    g.window = win;
  }
  for (const key of copyKeys) {
    if (key === 'window') {
      continue;
    }
    let value: unknown = key === 'React' ? React : winAsRec[key];
    if (key === 'getComputedStyle' && typeof value === 'function') {
      value = (value as (e: unknown) => unknown).bind(win);
    }
    if (value === undefined) {
      continue;
    }
    try {
      Object.defineProperty(g, key, { value, writable: true, configurable: true });
    } catch {
      g[key] = value;
    }
  }
  if (!g.NodeFilter) {
    g.NodeFilter = { SHOW_ALL: 4294967295, SHOW_ELEMENT: 1 };
  }
  if (!g.SVGElement) {
    g.SVGElement = (winAsRec.SVGElement ?? class {}) as unknown;
  }
  const matchMediaStub = (): unknown => ({
    matches: false,
    addListener: (): void => {},
    removeListener: (): void => {},
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  });
  try {
    Object.defineProperty(win, 'matchMedia', { value: matchMediaStub, writable: true, configurable: true });
  } catch {
    win.matchMedia = matchMediaStub;
  }
  (g as Record<string, unknown>).matchMedia = matchMediaStub;
  if (!win.ResizeObserver) {
    const RO = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    try {
      Object.defineProperty(win, 'ResizeObserver', { value: RO, writable: true, configurable: true });
    } catch {
      win.ResizeObserver = RO;
    }
    g.ResizeObserver = RO;
  }
  g.requestAnimationFrame = (cb: () => void): unknown => setTimeout(cb, 0);
  g.cancelAnimationFrame = (id: unknown): void => {
    clearTimeout(id as NodeJS.Timeout);
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const proto = (winAsRec.Element as unknown as { prototype: Record<string, unknown> })?.prototype;
  if (proto && !proto.scrollIntoView) {
    proto.scrollIntoView = (): void => {};
  }
  return dom;
}

/**
 * 预置网络边界桩（inner-jiti 共享 require.cache，预置后真实 store 走桩网络、不触真实后端）。
 * 仅桩边界（agentFlow/chatConversation），组件与 store 均为真实实现。
 */
function stubNetworkBoundary(): void {
  const agentFlowPath = path.resolve(repoRoot, 'app/services/agentFlow.ts');
  const chatConversationPath = path.resolve(repoRoot, 'lib/client/chatConversation.ts');
  const cache = (nodeRequire as unknown as { cache: Record<string, NodeModule> }).cache;
  cache[agentFlowPath] = {
    id: agentFlowPath,
    filename: agentFlowPath,
    loaded: true,
    exports: {
      interactWithAgent: async () => {},
      summarizeContext: async () => '桩摘要-M405',
    },
  } as unknown as NodeModule;
  cache[chatConversationPath] = {
    id: chatConversationPath,
    filename: chatConversationPath,
    loaded: true,
    exports: {
      fetchMyConversation: async () => [],
      saveMyConversation: async () => ({ ok: true }),
    },
  } as unknown as NodeModule;
}

// 中文注释：六态合法 Artifact fixture 工厂（id/sourceMessageId 对齐同一 assistant message）。
function makeArtifact(status: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: `artifact-${status}`,
    artifactType: 'story',
    sourceMessageId: 'msg-artifact-1',
    storyText: '从前有座山，山里有座庙，庙里有个小故事。',
    // 中文注释：M4-03 冻结快照——promotion 要求非空 prompt，种子必须自带（fail-fast 语义）。
    prompt: '请讲一个温柔的星夜故事。',
    voiceId: 'test-voice-m405',
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:01.000Z',
    status,
  };
  if (status === 'ready') {
    base.storyWorkId = 123;
  }
  if (status === 'promotion_failed') {
    base.error = 'network-error';
  }
  if (status === 'interrupted') {
    base.reason = 'stream_error';
  }
  return { ...base, ...overrides };
}

const LONG_TEXT = `${'星夜下的鲸鱼驮着微光前行，穿越银河般的海。'.repeat(12)}`;
const SHORT_TEXT = '短正文：月亮爬上山坡。';

async function runArtifactChatUiTests(): Promise<void> {
  setupJsdom();
  installAssetStubs();
  stubNetworkBoundary();
  const factory = nodeRequire('jiti') as unknown as JitiFactory;
  const innerJiti = factory(path.join(repoRoot, 'index.js'), {
    alias: { '@': repoRoot },
    jsx: true,
  });
  // 中文注释：经 inner-jiti 加载真实模块（同一实例，共享同一 Zustand store，避免双实例割裂）。
  const chatStoreMod = innerJiti('./stores/chatStore.ts') as unknown as { useChatStore: ChatStoreLike };
  const orchestrationMod = innerJiti('./lib/client/chatPromotionOrchestration.ts') as unknown as {
    setPromotionCreateOverride: (fn: ((input: unknown) => Promise<unknown>) | undefined) => void;
  };
  const artifactMod = innerJiti(
    './app/(main)/chat/components/MessageParts/StoryArtifactPart.tsx',
  ) as unknown as { default: React.ComponentType<{ part: unknown; messageId?: string }> };
  const storyCardMod = innerJiti(
    './app/(main)/chat/components/MessageParts/StoryCardPart.tsx',
  ) as unknown as {
    default: React.ComponentType<{ part: unknown; messageId?: string; onPlayStory?: (u: string) => void }>;
  };
  const generationMod = innerJiti('./stores/generationStore.ts') as unknown as {
    useGenerationStore: { setState: (p: Record<string, unknown>) => void };
  };
  const useChatStore = chatStoreMod.useChatStore;
  const StoryArtifactPartRenderer = artifactMod.default;
  const StoryCardPartRenderer = storyCardMod.default;
  const ReactMod = nodeRequire('react') as typeof React;
  const rtl = nodeRequire('@testing-library/react') as typeof import('@testing-library/react');

  const renderArtifact = (artifact: Record<string, unknown>, messageId?: string) =>
    rtl.render(
      ReactMod.createElement(StoryArtifactPartRenderer, {
        part: { type: 'storyArtifact', artifact },
        ...(messageId === undefined ? {} : { messageId }),
      }),
    );

  function resetBaseline(): void {
    useChatStore.getState().reset();
    useChatStore.setState({ syncEnabled: false });
  }

  /**
   * 向真实 store 植入一条携带指定 Artifact 的 assistant 消息（M4-05 只读渲染，不改 delivery）。
   */
  function seedAssistantMessage(artifact: Record<string, unknown>): void {
    useChatStore.setState({
      messages: [
        {
          id: 'msg-artifact-1',
          role: 'assistant',
          content: String(artifact.storyText ?? ''),
          parts: [{ type: 'storyArtifact', artifact }],
          status: 'delivered',
        },
      ] as never,
    });
  }

  // ==========================================================================
  // M4-05-10 / M4-05-02 / M4-05-12：Modern playback 纯净度＋Artifact 自有＋架构静态守卫
  // ==========================================================================
  console.log('=== M4-05-10/02/12: StoryArtifactPart 静态架构守卫 ===');
  {
    const source = readFileSync(
      path.join(repoRoot, 'app/(main)/chat/components/MessageParts/StoryArtifactPart.tsx'),
      'utf8',
    );
    // M4-05-10：Modern playback 预接必须删除（不是 disable），用户可见文案亦不得残留。
    const forbiddenPlayback = [
      'playStoryText',
      'usePlaybackStore',
      'usePlaybackProgressStore',
      'playbackStore',
      'playbackProgressStore',
      'audioUrl',
      'Pause',
      'Headphones',
      'generating_audio',
      'audioOverlay',
      'handlePlay',
      'isThisCardPlaying',
      'isThisCardResumePoint',
      '播放故事',
      '暂停播放',
      '继续收听',
      '正在生成语音',
      '从第',
    ];
    for (const token of forbiddenPlayback) {
      assert.ok(!source.includes(token), `Modern Artifact 不得含有 playback 预接残留：${token}`);
    }
    // M4-05-02：正文与状态必须归 Artifact 所有，不得读取全局 generation。
    const forbiddenGeneration = ['useGenerationStore', 'streamingText', 'generationStore'];
    for (const token of forbiddenGeneration) {
      assert.ok(!source.includes(token), `Modern Artifact 不得依赖全局 generation：${token}`);
    }
    assert.ok(source.includes('artifact.storyText'), '正文必须来自 artifact.storyText');
    assert.ok(source.includes('artifact.status'), '状态必须来自 artifact.status');
    // M4-05-12：不得直调服务端/持久化/promotion 执行层/playback 服务。
    const forbiddenArch = [
      '@/lib/server',
      'prisma',
      'libraryClient',
      'executePromotionCreate',
      'storyArtifactPromotion',
      'agentFlow',
      'chatFlow',
    ];
    for (const token of forbiddenArch) {
      assert.ok(!source.includes(token), `Modern Artifact UI 不得直达执行层：${token}`);
    }
    // 允许依赖：ChatArtifact 类型、chatStore dispatch、StoryViewer、导航/样式。
    assert.ok(source.includes('promotion.retry'), 'retry 必须走 promotion.retry action');
    assert.ok(source.includes('/library/'), 'ready 必须 handoff 到 /library/:id');
    assert.ok(source.includes('useChatStore'), '必须经 useChatStore dispatch');
    assert.ok(source.includes('StoryViewer'), '全文查看继续复用 StoryViewer');
    // M4-05-07：UI 层不得自造 promotion 语义（不新建 assistant、不换 source、不自维护 in-flight）。
    const forbiddenRetry = ['user.retry', 'createTempMessageId', 'sourceMessageId:', 'setRetrying', 'retrying'];
    for (const token of forbiddenRetry) {
      assert.ok(!source.includes(token), `UI 不得私设 promotion 语义：${token}`);
    }
    // 分发器清理：storyArtifact 分支不得再透传 onPlayStory（Legacy 分支保留契约）。
    const indexSource = readFileSync(
      path.join(repoRoot, 'app/(main)/chat/components/MessageParts/index.tsx'),
      'utf8',
    );
    assert.ok(
      !indexSource.includes('StoryArtifactPartRenderer part={part} messageId={messageId} onPlayStory'),
      'storyArtifact 分支必须切断 onPlayStory 透传',
    );
    assert.ok(
      indexSource.includes('onPlayStory?: (audioUrl: string) => void'),
      '通用 onPlayStory 契约必须保留（Legacy storyCard 仍用）',
    );
    assert.ok(
      indexSource.includes('StoryCardPartRenderer part={part} messageId={messageId} onPlayStory={onPlayStory}'),
      'Legacy storyCard 分支必须继续透传 onPlayStory',
    );
    // 共享 playback CSS 不得被误删（Legacy 仍用）。
    const scss = readFileSync(
      path.join(repoRoot, 'app/(main)/chat/components/MessageParts/index.module.scss'),
      'utf8',
    );
    for (const cls of ['.playButton', '.audioOverlay', '.playing', '.retryButton', '.libraryLink']) {
      assert.ok(scss.includes(cls), `样式缺失：${cls}`);
    }
  }
  console.log('PASS: M4-05-10/02/12 静态架构守卫');

  // ==========================================================================
  // M4-05-01：六态渲染契约（逐一不 crash、文案语义正确、正文可见、不误称 ready）
  // ==========================================================================
  console.log('=== M4-05-01: 六态渲染契约 ===');
  {
    resetBaseline();
    const expectations: Array<{
      status: string;
      header: string;
      text: string;
      mustAbsent: string[];
    }> = [
      { status: 'draft', header: '正在创作故事', text: SHORT_TEXT, mustAbsent: ['已保存', '重试保存', '查看作品', '播放'] },
      { status: 'complete', header: '故事正文已完成，准备保存', text: SHORT_TEXT, mustAbsent: ['已保存', '重试保存', '查看作品', '播放'] },
      { status: 'promoting', header: '正在保存到作品库', text: SHORT_TEXT, mustAbsent: ['重试保存', '查看作品', '已保存到作品库', '播放'] },
      { status: 'ready', header: '已保存到作品库', text: SHORT_TEXT, mustAbsent: ['重试保存', '播放', '准备保存'] },
      { status: 'promotion_failed', header: '保存失败，可重试保存', text: SHORT_TEXT, mustAbsent: ['生成已中断', '查看作品', '播放'] },
      { status: 'interrupted', header: '生成已中断', text: SHORT_TEXT, mustAbsent: ['重试保存', '查看作品', '播放', '已保存'] },
    ];
    for (const exp of expectations) {
      const r = renderArtifact(makeArtifact(exp.status, { storyText: exp.text }));
      try {
        assert.ok(await rtl.screen.findByText(exp.header), `${exp.status} 必须表达：${exp.header}`);
        assert.ok(await rtl.screen.findByText(exp.text), `${exp.status} 正文必须可见`);
        for (const absent of exp.mustAbsent) {
          assert.strictEqual(
            rtl.screen.queryByText(absent, { exact: false }),
            null,
            `${exp.status} 不得出现：${absent}`,
          );
        }
        // complete/promoting 绝不能被误称为 ready。
        if (exp.status === 'complete' || exp.status === 'promoting') {
          assert.strictEqual(rtl.screen.queryByText('已保存到作品库'), null, `${exp.status} 不得误称 ready`);
          assert.strictEqual(rtl.screen.queryByText('查看作品'), null, `${exp.status} 不得有 Library CTA`);
        }
      } finally {
        r.unmount();
      }
    }
    resetBaseline();
  }
  console.log('PASS: M4-05-01 六态渲染契约');

  // ==========================================================================
  // M4-05-02（行为）：draft 正文只归 Artifact 所有（全局 generation 文本不得串台）
  // ==========================================================================
  console.log('=== M4-05-02: draft 正文归属（Artifact A vs 全局 B）===');
  {
    resetBaseline();
    generationMod.useGenerationStore.setState({ phase: 'generating_text', streamingText: 'B-全局串台文本' });
    const r = renderArtifact(makeArtifact('draft', { storyText: 'A-Artifact自有正文' }));
    try {
      assert.ok(await rtl.screen.findByText('A-Artifact自有正文'), '必须只显示 Artifact 自有正文 A');
      assert.strictEqual(rtl.screen.queryByText('B-全局串台文本'), null, '全局 generation 文本 B 不得串台');
    } finally {
      r.unmount();
    }
    generationMod.useGenerationStore.setState({ phase: 'idle', streamingText: '' });
    resetBaseline();
  }
  console.log('PASS: M4-05-02 draft 正文归属');

  // ==========================================================================
  // M4-05-03：complete ≠ saved（可读全文、无已保存/CTA/retry/playback）
  // ==========================================================================
  console.log('=== M4-05-03: complete 可读但未保存 ===');
  {
    resetBaseline();
    const r = renderArtifact(makeArtifact('complete', { storyText: LONG_TEXT }), 'msg-artifact-1');
    try {
      assert.ok(await rtl.screen.findByText('故事正文已完成，准备保存'));
      assert.ok(await rtl.screen.findByText('查看全文'), 'complete 长文必须可查看全文');
      assert.strictEqual(rtl.screen.queryByText('重试保存'), null);
      assert.strictEqual(rtl.screen.queryByText('查看作品'), null);
      assert.strictEqual(rtl.screen.queryByText('已保存到作品库'), null);
      assert.strictEqual(document.querySelector('a[href^="/library/"]'), null);
      // 查看全文打开后完整正文可读。
      await rtl.act(async () => {
        rtl.fireEvent.click(await rtl.screen.findByText('查看全文'));
      });
      assert.ok(await rtl.screen.findByText(LONG_TEXT), '查看全文必须展示完整正文');
    } finally {
      r.unmount();
    }
    resetBaseline();
  }
  console.log('PASS: M4-05-03 complete 可读但未保存');

  // ==========================================================================
  // M4-05-04：promoting 面（正文仍在、无 retry/CTA/playback；即 retry 点击后的反馈态）
  // ==========================================================================
  console.log('=== M4-05-04: promoting 表面 ===');
  {
    resetBaseline();
    const r = renderArtifact(makeArtifact('promoting', { storyText: SHORT_TEXT }), 'msg-artifact-1');
    try {
      assert.ok(await rtl.screen.findByText('正在保存到作品库'));
      assert.ok(await rtl.screen.findByText(SHORT_TEXT), 'promoting 正文仍存在');
      assert.strictEqual(rtl.screen.queryByText('重试保存'), null);
      assert.strictEqual(rtl.screen.queryByText('查看作品'), null);
      assert.strictEqual(rtl.screen.queryByText('播放', { exact: false }), null);
    } finally {
      r.unmount();
    }
    resetBaseline();
  }
  console.log('PASS: M4-05-04 promoting 表面');

  // ==========================================================================
  // M4-05-05：ready → Library handoff（严格 /library/123，无 side effect）
  // ==========================================================================
  console.log('=== M4-05-05: ready Library handoff ===');
  {
    resetBaseline();
    const r = renderArtifact(makeArtifact('ready', { storyText: LONG_TEXT }), 'msg-artifact-1');
    try {
      assert.ok(await rtl.screen.findByText('已保存到作品库'));
      const link = (await rtl.screen.findByText('查看作品')).closest('a');
      assert.ok(link, '查看作品必须是导航锚点');
      assert.strictEqual(link?.getAttribute('href'), '/library/123', '目标必须严格是 /library/123');
      assert.strictEqual(rtl.screen.queryByText('重试保存'), null);
      assert.strictEqual(rtl.screen.queryByText('播放', { exact: false }), null);
    } finally {
      r.unmount();
    }
    resetBaseline();
  }
  console.log('PASS: M4-05-05 ready Library handoff');

  // ==========================================================================
  // M4-05-06：promotion_failed 保留正文（不渲染成“故事生成失败”）
  // ==========================================================================
  console.log('=== M4-05-06: promotion 失败保留 Artifact ===');
  {
    resetBaseline();
    const r = renderArtifact(
      makeArtifact('promotion_failed', { storyText: SHORT_TEXT, error: 'boom-raw' }),
      'msg-artifact-1',
    );
    try {
      assert.ok(await rtl.screen.findByText(SHORT_TEXT), '失败后原 storyText 仍完整显示');
      assert.ok(await rtl.screen.findByText('保存失败，可重试保存'));
      assert.ok(await rtl.screen.findByText('重试保存'), '必须有重试保存 CTA');
      assert.strictEqual(rtl.screen.queryByText('生成已中断'), null, '不得与 interrupted 混淆');
      assert.strictEqual(rtl.screen.queryByText('故事生成失败'), null, '不得渲染成故事生成失败');
      assert.strictEqual(rtl.screen.queryByText('boom-raw'), null, 'raw backend error 不直暴露');
    } finally {
      r.unmount();
    }
    resetBaseline();
  }
  console.log('PASS: M4-05-06 promotion 失败保留 Artifact');

  // ==========================================================================
  // M4-05-07：retry 唯一动作 ≡ dispatch({ type: 'promotion.retry', messageId })
  // ==========================================================================
  console.log('=== M4-05-07: retry action 归属 ===');
  {
    resetBaseline();
    const failed = makeArtifact('promotion_failed', { storyText: SHORT_TEXT });
    seedAssistantMessage(failed);
    // 中文注释：deferred create 桩——断言窗口内不结算，避免落库回写混入 dispatch 计数。
    orchestrationMod.setPromotionCreateOverride(
      () =>
        new Promise(() => {
          // 永不结算：本用例只断言 UI 派发与同步 promoting 切换。
        }),
    );
    const dispatched: unknown[] = [];
    const originalDispatch = useChatStore.getState().dispatch;
    useChatStore.setState({
      dispatch: (action: unknown) => {
        dispatched.push(action);
        return originalDispatch(action);
      },
    });
    const r = renderArtifact(failed, 'msg-artifact-1');
    try {
      await rtl.act(async () => {
        rtl.fireEvent.click(await rtl.screen.findByText('重试保存'));
      });
      assert.strictEqual(dispatched.length, 1, '点击一次必须恰好产生一次 dispatch');
      assert.deepStrictEqual(dispatched[0], { type: 'promotion.retry', messageId: 'msg-artifact-1' });
      // store 同步切回 promoting：UI 无需第二套 local loading 状态。
      const after = useChatStore
        .getState()
        .messages.find((m) => m.id === 'msg-artifact-1')
        ?.parts?.find((p) => p.type === 'storyArtifact')?.artifact;
      assert.strictEqual(after?.status, 'promoting', 'retry 后 Artifact 必须同步回到 promoting');
    } finally {
      r.unmount();
      useChatStore.setState({ dispatch: originalDispatch });
      orchestrationMod.setPromotionCreateOverride(undefined);
    }
    resetBaseline();
  }
  console.log('PASS: M4-05-07 retry action 归属');

  // ==========================================================================
  // M4-05-07b：fail-closed（messageId 缺失不得猜 latest）
  // ==========================================================================
  console.log('=== M4-05-07b: retry fail-closed ===');
  {
    resetBaseline();
    const failed = makeArtifact('promotion_failed', { storyText: SHORT_TEXT });
    seedAssistantMessage(failed);
    const dispatched: unknown[] = [];
    const originalDispatch = useChatStore.getState().dispatch;
    useChatStore.setState({
      dispatch: (action: unknown) => {
        dispatched.push(action);
        return originalDispatch(action);
      },
    });
    // messageId 缺失：渲染不带 messageId，点击必须 fail-closed。
    const r = renderArtifact(failed);
    try {
      await rtl.act(async () => {
        rtl.fireEvent.click(await rtl.screen.findByText('重试保存'));
      });
      assert.strictEqual(dispatched.length, 0, 'messageId 缺失时不得 dispatch（不猜 latest）');
      const after = useChatStore
        .getState()
        .messages.find((m) => m.id === 'msg-artifact-1')
        ?.parts?.find((p) => p.type === 'storyArtifact')?.artifact;
      assert.strictEqual(after?.status, 'promotion_failed', 'fail-closed 时状态不得变化');
    } finally {
      r.unmount();
      useChatStore.setState({ dispatch: originalDispatch });
    }
    resetBaseline();
  }
  console.log('PASS: M4-05-07b retry fail-closed');

  // ==========================================================================
  // M4-05-08：快速双击 retry → library.create 至多 1 个 in-flight（M4-04 防线不被破坏）
  // ==========================================================================
  console.log('=== M4-05-08: retry 双击 exactly-one ===');
  {
    resetBaseline();
    const failed = makeArtifact('promotion_failed', { storyText: SHORT_TEXT });
    seedAssistantMessage(failed);
    const createCalls: unknown[] = [];
    const pending: Array<{ resolve: (v: unknown) => void }> = [];
    orchestrationMod.setPromotionCreateOverride((input: unknown) => {
      createCalls.push(input);
      return new Promise((resolve) => {
        pending.push({ resolve });
      });
    });
    const r = renderArtifact(failed, 'msg-artifact-1');
    try {
      const btn = await rtl.screen.findByText('重试保存');
      await rtl.act(async () => {
        rtl.fireEvent.click(btn);
        rtl.fireEvent.click(btn);
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      assert.ok(createCalls.length <= 1, `快速双击最多 1 个 in-flight create，实得 ${createCalls.length}`);
      // 结算在途 create，确认仍能正常 ready（防线是去重而非吞掉）。
      await rtl.act(async () => {
        for (const p of pending.splice(0)) {
          p.resolve({ id: 123 });
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      const after = useChatStore
        .getState()
        .messages.find((m) => m.id === 'msg-artifact-1')
        ?.parts?.find((p) => p.type === 'storyArtifact')?.artifact;
      assert.strictEqual(after?.status, 'ready', '结算后应正常 ready');
    } finally {
      r.unmount();
      orchestrationMod.setPromotionCreateOverride(undefined);
    }
    resetBaseline();
  }
  console.log('PASS: M4-05-08 retry 双击 exactly-one');

  // ==========================================================================
  // M4-05-09：interrupted 与 promotion_failed 分家
  // ==========================================================================
  console.log('=== M4-05-09: interrupted 分离 ===');
  {
    resetBaseline();
    const r = renderArtifact(makeArtifact('interrupted', { storyText: '残篇：风起了…' }), 'msg-artifact-1');
    try {
      assert.ok(await rtl.screen.findByText('残篇：风起了…'), 'partial storyText 保留');
      assert.ok(await rtl.screen.findByText('生成已中断'));
      assert.strictEqual(rtl.screen.queryByText('重试保存'), null, 'interrupted 不得有 promotion retry');
      assert.strictEqual(rtl.screen.queryByText('查看作品'), null, 'interrupted 不得有保存 CTA');
      assert.strictEqual(rtl.screen.queryByText('播放', { exact: false }), null, 'interrupted 不得有 playback CTA');
      assert.strictEqual(rtl.screen.queryByText('保存失败，可重试保存'), null, '两种失败不得混成同一文案');
    } finally {
      r.unmount();
    }
    resetBaseline();
  }
  console.log('PASS: M4-05-09 interrupted 分离');

  // ==========================================================================
  // M4-05-11：Legacy storyCard 只读兼容（renderer 可加载、行为未动、CSS 未被误删）
  // ==========================================================================
  console.log('=== M4-05-11: Legacy 只读兼容 ===');
  {
    resetBaseline();
    const onPlayCalls: string[] = [];
    const r = rtl.render(
      ReactMod.createElement(StoryCardPartRenderer, {
        part: { type: 'storyCard', storyText: 'legacy历史正文', audioUrl: 'https://example.com/a.mp3' },
        messageId: 'msg-legacy-1',
        onPlayStory: (u: string) => {
          onPlayCalls.push(u);
        },
      }),
    );
    try {
      assert.ok(await rtl.screen.findByText('legacy历史正文'), '历史 storyCard 仍可渲染');
      const playBtn = await rtl.screen.findByText('播放故事');
      assert.ok(playBtn, 'Legacy 播放入口必须保留');
      await rtl.act(async () => {
        rtl.fireEvent.click(playBtn);
      });
      assert.deepStrictEqual(onPlayCalls, ['https://example.com/a.mp3'], 'Legacy onPlayStory 接线不变');
    } finally {
      r.unmount();
    }
    resetBaseline();
  }
  console.log('PASS: M4-05-11 Legacy 只读兼容');

  console.log('\nALL ARTIFACT CHAT UI TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runArtifactChatUiTests()
  .then(() => {
    console.log('ALL ARTIFACT CHAT UI TESTS PASSED SUCCESSFULLY!');
  })
  .catch((error) => {
    console.error('Artifact chat ui test failed:', error);
    process.exit(1);
  });

export default testPromise;
