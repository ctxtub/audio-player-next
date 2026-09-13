import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import type { LibraryCreateInput, StoryWorkDetailDTO } from '../../../lib/trpc/schemas/library';
import {
  isChatArtifact,
  isCompleteArtifact,
  isDraftArtifact,
} from '../../../types/chatArtifact';
import type {
  ChatMessage,
  MessagePart,
  StoryCardPart,
} from '../../../types/chat';
import {
  extractTextFromParts,
  isStoryArtifactPart,
  isStoryCardPart,
} from '../../../types/chat';
import {
  decodeLegacyStoryCard,
} from '../../../lib/client/chatStoryCompatibility';
import {
  assertNoNewLegacyStoryCardWrites,
} from '../../../lib/server/chatConversation';
import { TRPCError } from '../../../lib/trpc/init';
import {
  rehydrateServerMessages,
  serializePartsForHistory,
} from '../../../lib/client/chatArtifactHistory';

// 中文注释：M4-08 Legacy StoryCard Cutover / Read-Compatible, New-Write Forbidden 回归（E2E-08-08）。
// 不是“删除 Legacy”，而是把 Legacy 从“还能被生产的数据形态”降级成“只能消费既有历史的数据形态”：
// Modern runtime 只产 storyArtifact；已有 storyCard 可继续 decode/render/play/read 并随快照原样续存；
// NO conversion、NO promotion、NO new legacy creation。
// 本文件覆盖客户端侧：M4-08-01/02（Modern 链零 storyCard）、M4-08-03（persisted read compat）、
// M4-08-04（renderer 可用，真实渲染）、M4-08-05-client（既有 Legacy round-trip 序列化）、
// M4-08-06-collision（tuple fingerprint 碰撞拒绝，直测服务端 guard 纯函数）、M4-08-11
// （生产代码 Legacy 构造点纯度）；服务端 guard 由 L2 legacy-cutover integration 覆盖。
// 全程内存打桩，不建 socket、不绑端口，不碰 prisma/dev.db（guard 为纯函数，绝不查库）。

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

// 中文注释：先占桩——GlassToast / 会话落库 / Agent 交互，必须在 require chatStore 之前占位。
const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
nodeRequire.cache[glassToastPath] = {
  id: glassToastPath,
  filename: glassToastPath,
  loaded: true,
  exports: { default: { show: () => {}, clear: () => {} } },
} as unknown as NodeModule;

const chatConversationPath = path.resolve(process.cwd(), 'lib/client/chatConversation.ts');
nodeRequire.cache[chatConversationPath] = {
  id: chatConversationPath,
  filename: chatConversationPath,
  loaded: true,
  exports: {
    fetchMyConversation: async () => [],
    saveMyConversation: async () => ({ ok: true }),
  },
} as unknown as NodeModule;

const agentFlowPath = path.resolve(process.cwd(), 'app/services/agentFlow.ts');
nodeRequire.cache[agentFlowPath] = {
  id: agentFlowPath,
  filename: agentFlowPath,
  loaded: true,
  exports: {
    interactWithAgent: async () => {},
    summarizeContext: async () => '探针摘要-M408',
  },
} as unknown as NodeModule;

const { useChatStore } = nodeRequire('../../../stores/chatStore') as {
  useChatStore: typeof import('../../../stores/chatStore').useChatStore;
};

// 中文注释：可控 deferred promotion 桩——M4-08-01 需走完 promoting→ready 全链，结算由测试显式 resolve。
const { setPromotionCreateOverride } = nodeRequire(
  '../../../lib/client/chatPromotionOrchestration',
) as {
  setPromotionCreateOverride: typeof import('../../../lib/client/chatPromotionOrchestration').setPromotionCreateOverride;
};
let createCalls: LibraryCreateInput[] = [];
let pendingCreates: {
  input: LibraryCreateInput;
  resolve: (dto: StoryWorkDetailDTO) => void;
  reject: (err: unknown) => void;
}[] = [];
setPromotionCreateOverride((input: LibraryCreateInput) => {
  createCalls.push(input);
  return new Promise<StoryWorkDetailDTO>((resolve, reject) => {
    pendingCreates.push({ input, resolve, reject });
  });
});

type DispatchArg = Parameters<ReturnType<typeof useChatStore.getState>['dispatch']>[0];
type ChatMsg = ReturnType<typeof useChatStore.getState>['messages'][number];

function resetBaseline(): void {
  useChatStore.getState().reset();
  useChatStore.setState({ syncEnabled: false });
  createCalls = [];
  pendingCreates = [];
}

function submitAndGetAssistantId(content = '讲个睡前故事'): string {
  useChatStore.getState().dispatch({ type: 'user.submit', content } as DispatchArg);
  const assistantId = useChatStore.getState().selectors.latestAssistantMessage()?.id;
  assert.ok(assistantId, 'assistant 占位必须存在');
  return assistantId as string;
}

function getArtifact(id: string) {
  const msg = useChatStore.getState().messages.find((m) => m.id === id);
  assert.ok(msg, `消息必须存在: ${id}`);
  const part = (msg as ChatMsg).parts?.find((p) => p.type === 'storyArtifact') as
    | { type: 'storyArtifact'; artifact: { status: string; sourceMessageId: string; storyText: string; storyWorkId?: unknown } }
    | undefined;
  assert.ok(part, `消息必须持有 storyArtifact: ${id}`);
  return { msg: msg as ChatMsg, part };
}

function makeDto(id: number, input: LibraryCreateInput): StoryWorkDetailDTO {
  return {
    id,
    title: input.title ?? '测试标题',
    excerpt: input.storyText.slice(0, 20),
    voiceId: input.voiceId ?? '',
    contentHash: `hash-${id}`,
    favoritedAt: null,
    deletedAt: null,
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z',
    audio: { status: 'missing', durationMs: null },
    prompt: input.prompt,
    storyText: input.storyText,
    sourceMessageId: input.sourceMessageId ?? null,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await Promise.resolve();
  await Promise.resolve();
}

// 中文注释：M4-08-04 真实渲染 harness（jsdom + 真实 StoryCardPartRenderer，與 M4-05-11 同口径）。
// 仅验证 Legacy renderer 可用性；组件与 store 均为真实实现，网络边界（storyFlow 合成）走桩。
type JSDOMWindowLike = Record<string, unknown>;
type JSDOMLike = { window: JSDOMWindowLike };
type JSDOMCtorLike = new (html: string, opts?: Record<string, unknown>) => JSDOMLike;
type JitiInstance = (id: string) => Record<string, unknown>;
type JitiFactory = (base: string, opts: Record<string, unknown>) => JitiInstance;

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

async function main(): Promise<void> {
  console.log('=== M4-08-01: Modern fresh Story produces zero storyCard（全链 ready） ===');
  {
    resetBaseline();
    const assistantId = submitAndGetAssistantId('讲个小兔子故事');
    useChatStore.getState().dispatch({ type: 'stream.intent', intent: 'Story', messageId: assistantId } as DispatchArg);
    useChatStore.getState().dispatch({ type: 'stream.delta', content: '从前', messageId: assistantId } as DispatchArg);
    useChatStore.getState().dispatch({
      type: 'stream.story_complete', messageId: assistantId, storyText: '从前有只小兔子',
    } as DispatchArg);
    useChatStore.getState().dispatch({
      type: 'stream.finish',
      payload: { type: 'done', finishReason: 'stop' },
      messageId: assistantId,
    } as DispatchArg);
    // promotion 结算 → ready（Promotion / StoryWork 终态）。
    assert.strictEqual(pendingCreates.length, 1, '完整新链必须恰好 kick 一次 promotion');
    pendingCreates[0].resolve(makeDto(101, pendingCreates[0].input));
    await flush();
    const { part } = getArtifact(assistantId);
    assert.strictEqual(part.artifact.status, 'ready', '全链终态必须为 ready');
    const state = useChatStore.getState();
    const flat = JSON.stringify(state.messages);
    assert.ok(!flat.includes('"type":"storyCard"'), '新消息 storyCard count 必须为 0');
    assert.ok(!flat.includes('storyCard'), '运行时不得出现 storyCard 写入');
    const storyArtifactCount = (state.messages.flatMap((m) => m.parts ?? []) as MessagePart[])
      .filter((p) => p.type === 'storyArtifact').length;
    assert.strictEqual(storyArtifactCount, 1, '新消息 storyArtifact count 必须为 1');
    console.log('PASS: M4-08-01 fresh story zero storyCard');
  }

  console.log('=== M4-08-02: Retry remains Modern-only ===');
  {
    resetBaseline();
    const firstAssistant = submitAndGetAssistantId('重试用例正文');
    useChatStore.getState().dispatch({ type: 'stream.fail', error: 'net', messageId: firstAssistant } as DispatchArg);
    const users = useChatStore.getState().messages.filter((m) => m.role === 'user');
    assert.ok(users.length > 0, '必须存在 user 消息');
    const lastUserIndex = useChatStore.getState().messages.findLastIndex((m) => m.role === 'user');
    useChatStore.getState().messages[lastUserIndex] = {
      ...useChatStore.getState().messages[lastUserIndex],
      status: 'failed',
    };
    useChatStore.getState().dispatch({ type: 'user.retry' } as DispatchArg);
    const retryAssistantId = useChatStore.getState().selectors.latestAssistantMessage()?.id;
    assert.ok(retryAssistantId, 'retry 后新 assistant 必须存在');
    const { part } = getArtifact(retryAssistantId as string);
    assert.strictEqual(part.artifact.status, 'draft', 'retry 新 assistant 必须为 StoryArtifact draft');
    const retryMsg = useChatStore.getState().messages.find((m) => m.id === retryAssistantId);
    assert.ok(!(retryMsg?.parts ?? []).some((p) => p.type === 'storyCard'), 'retry 绝不能产生 StoryCardPart');
    // 随后 complete / promotion 仍正常。
    useChatStore.getState().dispatch({
      type: 'stream.story_complete', messageId: retryAssistantId, storyText: '重试后完整正文',
    } as DispatchArg);
    assert.strictEqual(pendingCreates.length, 1, 'retry 链必须 kick 一次 promotion');
    pendingCreates[0].resolve(makeDto(102, pendingCreates[0].input));
    await flush();
    const after = getArtifact(retryAssistantId as string);
    assert.strictEqual(after.part.artifact.status, 'ready', 'retry 链终态必须为 ready');
    const flat = JSON.stringify(useChatStore.getState().messages);
    assert.ok(!flat.includes('storyCard'), 'retry 全程不得出现 storyCard');
    console.log('PASS: M4-08-02 retry modern-only');
  }

  console.log('=== M4-08-03: Legacy persisted read compatibility（decode/render/play/read 上下文） ===');
  {
    resetBaseline();
    // 预置旧服务端数据形态，经 M4-06 codec 恢复（initForUser 口径）。
    const legacyDto = {
      messageId: 'old-1',
      role: 'assistant',
      content: 'legacy story',
      parts: [{ type: 'storyCard', storyText: 'legacy story', audioUrl: 'old-url' }],
      agentType: 'story_agent',
      createdAt: '2026-08-01T10:00:00.000Z',
    };
    const recovered = rehydrateServerMessages([legacyDto] as never);
    assert.strictEqual(recovered.length, 1, '旧消息必须恢复 1 条');
    assert.strictEqual(recovered[0].parts?.[0]?.type, 'storyCard', 'type 必须仍为 storyCard');
    assert.strictEqual(
      (recovered[0].parts?.[0] as StoryCardPart).storyText,
      'legacy story',
      'storyText 精确保留',
    );
    assert.ok(
      !(recovered[0].parts ?? []).some((p) => p.type === 'storyArtifact'),
      '不得出现 StoryArtifact（NO conversion）',
    );
    // 类型层只读入口保留：守卫 + 上下文提取。
    const card = recovered[0].parts?.[0] as MessagePart;
    assert.strictEqual(isStoryCardPart(card), true, 'isStoryCardPart 必须保留');
    assert.strictEqual(isStoryArtifactPart(card), false);
    assert.strictEqual(
      extractTextFromParts(recovered[0].parts as MessagePart[]),
      'legacy story',
      'extractTextFromParts 仍必须能取 storyCard.storyText（context/summary 口径）',
    );
    // decoder 只读铁律：可解码、可展示，绝不转 Complete Artifact。
    const decoded = decodeLegacyStoryCard({
      type: 'storyCard', storyText: 'legacy story', audioUrl: 'old-url',
    });
    assert.ok(decoded !== null, 'decodeLegacyStoryCard 必须可解旧卡');
    assert.strictEqual(decoded.type, 'storyCard');
    assert.strictEqual(isChatArtifact(decoded as never), false, 'Legacy 卡绝非 ChatArtifact');
    assert.strictEqual(isDraftArtifact(decoded as never), false);
    assert.strictEqual(isCompleteArtifact(decoded as never), false);
    // selectors 只读保留：hasStoryMessages 识别历史卡。
    useChatStore.setState({ messages: recovered as ChatMessage[] });
    assert.strictEqual(
      useChatStore.getState().selectors.hasStoryMessages(),
      true,
      'hasStoryMessages 必须继续识别 Legacy storyCard',
    );
    console.log('PASS: M4-08-03 legacy read compatibility');
  }

  console.log('=== M4-08-04: Legacy renderer remains usable（真实渲染） ===');
  {
    setupJsdom();
    installAssetStubs();
    const repoRoot: string = process.cwd();
    // 中文注释：audioUrl 为空的兼容重合成路径走 storyFlow.playStoryText，必须先占桩（不触真实 TTS）。
    const resynthCalls: Array<{ storyText: string; messageId?: string }> = [];
    const storyFlowPath = path.resolve(repoRoot, 'app/services/storyFlow.ts');
    (nodeRequire as unknown as { cache: Record<string, NodeModule> }).cache[storyFlowPath] = {
      id: storyFlowPath,
      filename: storyFlowPath,
      loaded: true,
      exports: {
        playStoryText: async (storyText: string, messageId?: string) => {
          resynthCalls.push({ storyText, messageId });
        },
      },
    } as unknown as NodeModule;
    const factory = nodeRequire('jiti') as unknown as JitiFactory;
    const innerJiti = factory(path.join(repoRoot, 'index.js'), {
      alias: { '@': repoRoot },
      jsx: true,
    });
    const storyCardMod = innerJiti(
      './app/(main)/chat/components/MessageParts/StoryCardPart.tsx',
    ) as unknown as {
      default: React.ComponentType<{ part: unknown; messageId?: string; onPlayStory?: (u: string) => void }>;
    };
    const StoryCardPartRenderer = storyCardMod.default;
    const ReactMod = nodeRequire('react') as typeof React;
    const rtl = nodeRequire('@testing-library/react') as typeof import('@testing-library/react');

    // 有 persisted audioUrl：沿旧 callback 播放。
    const legacyCalls: string[] = [];
    const r1 = rtl.render(
      ReactMod.createElement(StoryCardPartRenderer, {
        part: { type: 'storyCard', storyText: 'legacy历史正文', audioUrl: 'https://example.com/a.mp3' },
        messageId: 'msg-legacy-1',
        onPlayStory: (u: string) => {
          legacyCalls.push(u);
        },
      }),
    );
    try {
      assert.ok(await rtl.screen.findByText('legacy历史正文'), '历史 storyCard storyText 必须可见');
      const playBtn = await rtl.screen.findByText('播放故事');
      assert.ok(playBtn, 'playback action 必须存在');
      await rtl.act(async () => {
        rtl.fireEvent.click(playBtn);
      });
      assert.deepStrictEqual(legacyCalls, ['https://example.com/a.mp3'], '有 persisted audioUrl 时沿旧 callback');
    } finally {
      r1.unmount();
    }

    // audioUrl 为空（M4-06 sanitize 后形态）：仍走既有 compatibility playback 路径（按正文重合成）。
    const LONG_LEGACY = `兼容重合成长正文段落：${'星夜下的鲸鱼驮着微光前行，穿越银河般的海。'.repeat(8)}`;
    const r2 = rtl.render(
      ReactMod.createElement(StoryCardPartRenderer, {
        part: { type: 'storyCard', storyText: LONG_LEGACY, audioUrl: '' },
        messageId: 'msg-legacy-2',
        onPlayStory: (u: string) => {
          legacyCalls.push(u);
        },
      }),
    );
    try {
      const expandBtn = await rtl.screen.findByText('查看全文');
      assert.ok(expandBtn, '长正文查看全文必须有效');
      await rtl.act(async () => {
        rtl.fireEvent.click(expandBtn);
      });
      assert.ok(await rtl.screen.findByText(LONG_LEGACY), '展开全文必须展示完整正文');
      // 关闭弹窗后点播放，走重合成路径。
      const closeBtn = rtl.screen.queryByLabelText('关闭');
      if (closeBtn) {
        await rtl.act(async () => {
          rtl.fireEvent.click(closeBtn);
        });
      }
      const playBtn2 = await rtl.screen.findByText('播放故事');
      await rtl.act(async () => {
        rtl.fireEvent.click(playBtn2);
      });
      assert.strictEqual(legacyCalls.length, 1, 'audioUrl 为空时不得走旧 audioUrl callback');
      assert.strictEqual(resynthCalls.length, 1, 'audioUrl 为空时必须走按正文重合成路径');
      assert.strictEqual(resynthCalls[0].storyText, LONG_LEGACY, '重合成必须携带完整正文');
      assert.strictEqual(resynthCalls[0].messageId, 'msg-legacy-2', '重合成必须传递真实 messageId（断点定位）');
    } finally {
      r2.unmount();
    }
    console.log('PASS: M4-08-04 legacy renderer usable');
  }

  console.log('=== M4-08-05-client: Existing Legacy may round-trip（serialize 透传不挡老历史） ===');
  {
    const parts: MessagePart[] = [
      { type: 'storyCard', storyText: 'legacy', audioUrl: 'https://temporary/old.mp3' },
    ];
    const serialized = serializePartsForHistory(parts);
    assert.ok(serialized, '既有 Legacy 序列化不得为空');
    assert.strictEqual(serialized?.[0]?.type, 'storyCard', 'storyCard 不得被 drop/转换');
    assert.strictEqual(
      (serialized?.[0] as StoryCardPart).storyText,
      'legacy',
      '正文 identity 不得改动',
    );
    assert.strictEqual(
      (serialized?.[0] as StoryCardPart).audioUrl,
      '',
      'audioUrl 归一为空（非持久字段）',
    );
    // 回水：audioUrl '' 与旧 temp-url 视为同一张卡（fingerprint 不含 audioUrl，由 L2 断言）。
    const rehydrated = rehydrateServerMessages([{
      messageId: 'old-1', role: 'assistant', content: 'legacy', parts: serialized as never,
    }] as never);
    assert.strictEqual(rehydrated[0].parts?.[0]?.type, 'storyCard');
    assert.strictEqual((rehydrated[0].parts?.[0] as StoryCardPart).storyText, 'legacy');
    console.log('PASS: M4-08-05-client round-trip');
  }

  console.log('=== M4-08-06-collision: tuple fingerprint 碰撞不得绕过 guard ===');
  {
    // M4-08 fixup：identity 是真正 tuple (messageId, storyText)，无拼接歧义。
    // 碰撞例：persisted ("A", "B\u0000C") vs incoming ("A\u0000B", "C")——拼接 key 下同键，
    // tuple 下不同桶，后者是新 Legacy，必须 BAD_REQUEST。
    const persisted = [
      {
        messageId: 'A',
        parts: JSON.stringify([{ type: 'storyCard', storyText: 'B\u0000C', audioUrl: '' }]),
      },
    ];
    const colliding = [
      {
        messageId: 'A\u0000B',
        role: 'assistant',
        content: 'C',
        parts: [{ type: 'storyCard', storyText: 'C', audioUrl: '' }],
      },
    ];
    assert.throws(
      () => assertNoNewLegacyStoryCardWrites(persisted, colliding as never),
      (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
      'tuple 碰撞的新 Legacy 必须以 BAD_REQUEST 拒绝',
    );
    // 对照：完全相同的 tuple 原样保留必须通过（含 \u0000 内容本身）。
    assert.doesNotThrow(
      () =>
        assertNoNewLegacyStoryCardWrites(persisted, [
          {
            messageId: 'A',
            role: 'assistant',
            content: 'B\u0000C',
            parts: [{ type: 'storyCard', storyText: 'B\u0000C', audioUrl: '' }],
          },
        ] as never),
      '相同 tuple 原样续存必须通过',
    );
    console.log('PASS: M4-08-06-collision tuple provenance');
  }

  console.log('=== M4-08-11: Architecture writer purity（构造点仅 allowlist decoder） ===');
  {
    // 审计口径：不是“源码零 storyCard 字符串”（reader 必须保留），而是
    // “没有能新产生 storyCard 的业务路径”——对象构造仅允许 compatibility decoder。
    // M4-09 containment：decoder 已从 chatArtifactState.ts 迁移至 chatStoryCompatibility.ts。
    const prodRoots = ['app', 'lib/client', 'stores', 'components'];
    const allowlistedFiles = new Set([
      path.resolve(process.cwd(), 'lib/client/chatStoryCompatibility.ts'),
    ]);
    const constructorRe = /type\s*:\s*['"]storyCard['"]/;
    const violations: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const content = fs.readFileSync(full, 'utf8');
        if (!constructorRe.test(content)) continue;
        if (allowlistedFiles.has(path.resolve(full))) continue;
        violations.push(path.relative(process.cwd(), full));
      }
    };
    for (const root of prodRoots) {
      walk(path.resolve(process.cwd(), root));
    }
    assert.deepStrictEqual(violations, [], `生产代码 Legacy 构造点必须仅存 allowlist decoder，违规：${violations.join(', ')}`);
    // allowlist 自身确为 read boundary：decodeLegacyStoryCard 存在且声明不转 Artifact/不建 StoryWork。
    const decoderSource = fs.readFileSync(
      path.resolve(process.cwd(), 'lib/client/chatStoryCompatibility.ts'), 'utf8',
    );
    assert.ok(decoderSource.includes('decodeLegacyStoryCard'), 'allowlist decoder 必须存在');
    // decoder 为纯读：不得 import Library 门面、不得调用入库写（注释提及除外）。
    assert.ok(!/from\s+['"][^'"]*library[^'"]*['"]/i.test(decoderSource), 'decoder 不得 import Library 模块');
    assert.ok(!/\blibrary\s*\.\s*create\s*\(/.test(decoderSource), 'decoder 不得调用 library.create');
    // M4-09 containment：chatStore 不再直读 wire，只经 compatibility helper。
    const storeSource = fs.readFileSync(path.resolve(process.cwd(), 'stores/chatStore.ts'), 'utf8');
    assert.ok(!/['"]storyCard['"]/.test(storeSource), 'M4-09 containment：chatStore 不得直读 Legacy wire 字面量');
    assert.ok(!storeSource.includes('StoryCardPart'), 'M4-09 containment：chatStore 不得 import Legacy 类型');
    assert.ok(storeSource.includes('chatStoryCompatibility'), 'chatStore 必须经 compatibility helper 查询 Legacy');
    const messagePartsSource = fs.readFileSync(
      path.resolve(process.cwd(), 'app/(main)/chat/components/MessageParts/index.tsx'), 'utf8',
    );
    assert.ok(messagePartsSource.includes('storyCard'), 'MessageParts storyCard 分支必须保留');
    const chatTypesSource = fs.readFileSync(path.resolve(process.cwd(), 'types/chat.ts'), 'utf8');
    assert.ok(chatTypesSource.includes('StoryCardPart'), 'StoryCardPart 类型必须保留');
    assert.ok(chatTypesSource.includes('isStoryCardPart'), 'isStoryCardPart 必须保留');
    assert.ok(chatTypesSource.includes('storyCard.storyText') || chatTypesSource.includes("part.storyText"), 'extractTextFromParts storyCard 口径必须保留');
    console.log('PASS: M4-08-11 writer purity');
  }

  console.log('=== M4-08-12-client: frozen boundary（codec/M2/reader 未动） ===');
  {
    // M4-06 codec 语义抽查：storyCard 透传不转不删（行为冻结，细则由 M4-06 套件锁定）。
    const passthrough = serializePartsForHistory([
      { type: 'storyCard', storyText: 'frozen', audioUrl: 'x' },
    ] as MessagePart[]);
    assert.strictEqual(passthrough?.[0]?.type, 'storyCard', 'codec 不得 drop/转换 storyCard');
    // Legacy renderer 文件仍存在。
    assert.ok(
      fs.existsSync(path.resolve(process.cwd(), 'app/(main)/chat/components/MessageParts/StoryCardPart.tsx')),
      'StoryCardPart.tsx 必须存在',
    );
    assert.ok(
      fs.existsSync(path.resolve(process.cwd(), 'app/(main)/chat/components/MessageParts/StoryArtifactPart.tsx')),
      'StoryArtifactPart.tsx 必须存在',
    );
    console.log('PASS: M4-08-12-client frozen boundary');
  }

  console.log('\nALL LEGACY CUTOVER UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = main()
  .then(() => {
    console.log('ALL LEGACY CUTOVER UNIT TESTS PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('TEST FAILED:', err);
    process.exit(1);
  })
  .finally(() => {
    setPromotionCreateOverride(undefined);
    useChatStore.getState().reset();
  });

export default testPromise;
