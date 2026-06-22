# player 生成能力并入 chat 实施计划

> 配套 spec：[docs/specs/2026-06-22-player-chat-consolidation.md](../specs/2026-06-22-player-chat-consolidation.md)。步骤用 `- [ ]` 勾选。

**Goal:** 把 story 生成统一收归 chat，/player 退化为纯播放 + 历史视图，闭环遗留项 2（player 生成清空聊天）。

**Architecture:** /player 移除生成输入（减法）；chat 承接「提示词历史记录」与「跨页自动发送」；删死代码 `beginStorySession`。

**Tech Stack:** Next.js App Router + Zustand + tRPC。无 test runner（验证靠 lint/tsc/build + dev 预览活体）。bundle 提交：spec+plan+code 一次提交（与本仓库 5f16c48 等惯例一致）。

---

### Task 1: chatStore 增加瞬态 `pendingAutoSend`

**Files:** Modify `stores/chatStore.ts`

- [ ] **Step 1**：基础状态类型加字段。把
```ts
  /** 是否处于登录态（开启服务端持久化）。 */
  syncEnabled: boolean;
};
```
改为
```ts
  /** 是否处于登录态（开启服务端持久化）。 */
  syncEnabled: boolean;
  /** 跨页自动发送的待发提示词（来自 /player 历史记录选择，瞬态、不持久化）。 */
  pendingAutoSend: string | null;
};
```

- [ ] **Step 2**：动作类型加 setter。把
```ts
  /** 更新输入框的实时内容。 */
  setInputValue: (nextValue: string) => void;
```
改为
```ts
  /** 更新输入框的实时内容。 */
  setInputValue: (nextValue: string) => void;
  /** 设置/清空跨页自动发送的待发提示词。 */
  setPendingAutoSend: (prompt: string | null) => void;
```

- [ ] **Step 3**：初始值。把
```ts
  messages: [],
  inputValue: '',
  hasUnviewedResponse: false,
  syncEnabled: false,
```
改为
```ts
  messages: [],
  inputValue: '',
  hasUnviewedResponse: false,
  syncEnabled: false,
  pendingAutoSend: null,
```

- [ ] **Step 4**：实现。把
```ts
  setInputValue: (nextValue) => {
    set({ inputValue: nextValue });
  },
```
改为
```ts
  setInputValue: (nextValue) => {
    set({ inputValue: nextValue });
  },
  setPendingAutoSend: (prompt) => {
    set({ pendingAutoSend: prompt });
  },
```

- [ ] **Step 5**：`yarn tsc --noEmit` 通过。

---

### Task 2: chatFlow 在 story-finish 处记录提示词历史

**Files:** Modify `app/services/chatFlow.ts`

- [ ] **Step 1**：加 import（在第 4 行 `useGenerationHistoryStore` import 下）。
```ts
import { usePromptHistoryStore } from '@/stores/promptHistoryStore';
```

- [ ] **Step 2**：在 `recordHistory` 块内、`generationHistory.record` 之后追加提示词记录。把
```ts
              // 4. 记录到生成历史（仅用户主动发起的生成；预加载续写不记录）
              if (recordHistory) {
                useGenerationHistoryStore
                  .getState()
                  .record(triggerPrompt, generatedContent, voiceId);
              }
```
改为
```ts
              // 4. 记录到生成历史 + 提示词历史（仅用户主动发起、真正生成了故事时记；预加载续写不记录）
              if (recordHistory) {
                useGenerationHistoryStore
                  .getState()
                  .record(triggerPrompt, generatedContent, voiceId);
                usePromptHistoryStore.getState().addOrUpdate(triggerPrompt);
              }
```

- [ ] **Step 3**：`yarn tsc --noEmit` 通过。

---

### Task 3: ChatLayout 挂载时消费 `pendingAutoSend`（预填 + 自动发送）

**Files:** Modify `app/(main)/chat/components/ChatLayout/index.tsx`

- [ ] **Step 1**：在 `handleSubmit`（`useCallback`，约第 100-108 行）定义之后插入一个 useEffect。紧接 `handleSubmit` 的 `}, []);` 之后加入：
```ts

  // 来自 /player 历史记录「选一条」的跨页自动发送：预填输入框并发送，仅消费一次。
  useEffect(() => {
    const pending = useChatStore.getState().pendingAutoSend;
    if (!pending) {
      return;
    }
    useChatStore.getState().setPendingAutoSend(null);
    setInputValue(pending);
    handleSubmit(pending);
  }, [handleSubmit, setInputValue]);
```
（`useEffect`、`useChatStore`、`setInputValue` 均已在本文件导入/取用，无需新增 import。）

- [ ] **Step 2**：`yarn tsc --noEmit` 通过。

---

### Task 4: 瘦身 InputStatusSection 为「历史操作条」

**Files:** Modify `app/(main)/player/components/InputStatusSection/index.tsx`（整文件替换）

> 文件夹名沿用 `InputStatusSection` 以减少改动面（其职责已变为历史入口），顶部注释说明。复用既有 scss 类（container / quickButtons / quickButton / historyButton），`index.module.scss` 不必改（残留的生成相关类不影响）。

- [ ] **Step 1**：整文件替换为：
```tsx
'use client';

import React, { useRef } from 'react';
import { useRouter } from 'next/navigation';
import HistoryRecords, { HistoryRecordsRef } from '@/app/(main)/player/components/HistoryRecords';
import GenerationHistory, { GenerationHistoryRef } from '@/app/(main)/player/components/GenerationHistory';
import { useChatStore } from '@/stores/chatStore';

import styles from './index.module.scss';

/**
 * 播放器页历史操作条：仅承载「历史记录（提示词历史）」与「生成历史」两个入口。
 * 故事生成能力已统一收归创作（chat）页；选择历史提示词将跳转 chat 预填并自动发送。
 * （文件夹名沿用 InputStatusSection 以减少改动面，其职责已变为历史入口。）
 */
const InputStatusSection: React.FC = () => {
  /** 路由：选择提示词后跳转创作页。 */
  const router = useRouter();
  /** 提示词历史弹窗引用。 */
  const historyRecordsRef = useRef<HistoryRecordsRef>(null);
  /** 生成历史弹窗引用。 */
  const generationHistoryRef = useRef<GenerationHistoryRef>(null);
  /** 设置跨页待发提示词。 */
  const setPendingAutoSend = useChatStore((state) => state.setPendingAutoSend);

  /** 打开提示词历史弹窗。 */
  const handleHistoryButtonClick = () => {
    historyRecordsRef.current?.showModal();
  };

  /** 打开生成历史弹窗。 */
  const handleGenerationHistoryClick = () => {
    generationHistoryRef.current?.showModal();
  };

  /** 选择历史提示词：交给 chat 自动发送（预填 + 发送），并跳转创作页。 */
  const handleSelectHistoryPrompt = (prompt: string) => {
    setPendingAutoSend(prompt);
    router.push('/chat');
  };

  return (
    <div className={styles.container}>
      <div className={styles.quickButtons}>
        <button
          className={`${styles.quickButton} ${styles.historyButton}`}
          onClick={handleHistoryButtonClick}
          title="查看历史提示词记录"
        >
          历史记录
        </button>
        <button
          className={`${styles.quickButton} ${styles.historyButton}`}
          onClick={handleGenerationHistoryClick}
          title="查看生成历史并回放"
        >
          生成历史
        </button>
      </div>

      {/* 历史记录弹窗 */}
      <HistoryRecords ref={historyRecordsRef} onSelectPrompt={handleSelectHistoryPrompt} />

      {/* 生成历史弹窗 */}
      <GenerationHistory ref={generationHistoryRef} />
    </div>
  );
};

export default InputStatusSection;
```

- [ ] **Step 2**：`yarn tsc --noEmit` 通过。

---

### Task 5: player 页移除生成接线

**Files:** Modify `app/(main)/player/index.tsx`（整文件替换）

- [ ] **Step 1**：整文件替换为：
```tsx
'use client';

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import PlaybackStatusBoard from '@/app/(main)/player/components/PlaybackStatusBoard';
import GenerationPreview from '@/app/(main)/player/components/GenerationPreview';
import AudioPlayer from '@/app/(main)/player/components/AudioPlayer';

import { useConfigStore } from '@/stores/configStore';
import InputStatusSection from './components/InputStatusSection';
import styles from './index.module.scss';

/**
 * 播放器页：纯播放 + 历史视图。故事生成已统一收归创作（chat）页。
 * @returns 播放器页 JSX 结构
 */
const HomePage: React.FC = () => {
  /** 路由：配置无效时跳转配置页。 */
  const router = useRouter();

  // 配置加载与校验（登录/访客初始化已由 AccountSyncProvider 全局接管）
  const isConfigLoaded = useConfigStore(state => state.isLoaded);
  const configIsValid = useConfigStore(state => state.isConfigValid());

  useEffect(() => {
    if (!isConfigLoaded) {
      return;
    }
    if (!configIsValid) {
      router.push('/config');
    }
  }, [isConfigLoaded, configIsValid, router]);

  return (
    <div className={styles.homePage}>
      <div className={styles.pageSection}>
        <PlaybackStatusBoard />

        <GenerationPreview />

        <InputStatusSection />

        <AudioPlayer />
      </div>
    </div>
  );
};

export default HomePage;
```

- [ ] **Step 2**：`yarn tsc --noEmit` 通过（确认 `GlassToast`/`useChatStore`/`usePlaybackStore`/`beginStorySession`/`resetStoryFlow` 等已无未用导入报错）。

---

### Task 6: 删除死代码 `beginStorySession`

**Files:** Modify `app/services/storyFlow.ts`

- [ ] **Step 1**：删除 `beginChatStream` 导入（第 8 行）：
```ts
import { beginChatStream } from './chatFlow';
```

- [ ] **Step 2**：删除 `beginStorySession` 函数及其文档注释（约第 96-104 行）：
```ts
/**
 * 启动新的故事会话：清空旧状态、生成首段文本与音频，并初始化播放会话及启动播放。
 * @param prompt 用户输入的故事提示词
 */
export const beginStorySession = async (prompt: string) => {
  resetStoryFlow();
  const { messageId, audioUrl } = await beginChatStream(prompt);
  await startStoryPlayback(messageId, audioUrl);
};
```
（`resetStoryFlow` 仍由 chat「清空」按钮使用，保留；`startStoryPlayback` 仍被 chatFlow 等使用，保留。）

- [ ] **Step 3**：确认无残留引用：
```bash
grep -rn "beginStorySession" app components stores
```
Expected：无输出。

- [ ] **Step 4**：`yarn tsc --noEmit` 通过。

---

### Task 7: 三道门 + 活体验证 + 单次提交

- [ ] **Step 1**：三道门
```bash
yarn lint && yarn tsc --noEmit && yarn build
```
Expected：全绿（lint 仅既有无关告警 `lib/agent/nodes/summary.ts`）。

- [ ] **Step 2**：dev 预览活体
  - /player 无生成输入框，仅播放面板 + 音频 + 两历史入口。
  - 在 chat 生成故事正常：正文 + 播放 + 生成历史新增 + **提示词历史新增**。
  - /player「历史记录」选一条 → 跳 /chat、输入框预填并**自动发送**。
  - chat 有对话后切 /player → 聊天会话**未被清空**（遗留项 2 闭环）。

- [ ] **Step 3**：单次提交（spec + plan + code）
```bash
git add app/ stores/chatStore.ts docs/specs/2026-06-22-player-chat-consolidation.md docs/plans/2026-06-22-player-chat-consolidation.md
git commit -m "$(cat <<'EOF'
refactor: 故事生成统一收归 chat，player 退化为播放+历史视图

移除 /player 的故事生成入口（消除与 chat 的重复能力）：删生成文本框/
按钮与 beginStorySession 接线，InputStatusSection 瘦身为历史操作条。
承接被移走的能力：提示词历史改在 chatFlow story-finish 处记录（与生成
历史同闸门）；提示词历史「选一条」经 chatStore.pendingAutoSend 跳转
chat 预填并自动发送。player 不再 resetChat，闭环账号绑定遗留项 2
（player 生成不再清空已持久化聊天会话）。

SDD：docs/specs|plans/2026-06-22-player-chat-consolidation.md。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## 自审

**Spec 覆盖：** 生成只在 chat（Task 5/6）✓；player 留播放+双历史（Task 4/5）✓；提示词记录搬入 chat（Task 2）✓；提示词选择跳转自动发送（Task 1/3/4）✓；遗留项 2 闭环（Task 5/6 去 resetChat 路径）✓；验收 1-6（Task 7）✓。

**占位符扫描：** 无 TBD/TODO；每步给完整代码。

**类型一致：** `pendingAutoSend: string | null` / `setPendingAutoSend(prompt: string | null)` 在 Task 1 定义、Task 3/4 使用一致；`addOrUpdate(prompt: string)` 与 promptHistoryStore 现签名一致；`HistoryRecordsRef`/`GenerationHistoryRef`/`onSelectPrompt` 沿用既有组件接口。
</content>
