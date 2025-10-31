# Zustand 状态管理改造方案

## 背景与目标
- 统一跨页面状态源，消除重复维护 `apiConfig`、播放信息等导致的竞态与不一致。
- 将副作用（接口请求、定时器、localStorage 操作等）迁移到 store 层，降低组件复杂度并提升可测性。
- 为后续扩展（多端渲染、多播放器、独立设置页面等）预留清晰的状态边界。

## 现状梳理（2024-08）
### Home 页面 `app/pages/Home/index.tsx`
- 同时维护 `apiConfig`、`userState`、`storyState`、`playerState`、`preloadState` 等多块状态，通过 `useRef` 保持最新值，存在较大耦合。
- 生成故事、拉取音频、播放/预加载等业务流程集中在组件内，难以复用与测试。
- `apiConfig` 初始化与校验逻辑与 Config 页重复，并直接依赖 localStorage。

### Config 页面 `app/pages/Config/index.tsx`
- 再次维护 `apiConfig` 副本，保存逻辑散落在页面内部。
- 试听音频状态（`playingVoice`）只在本页维护，后续扩展会困难。

### UI 组件层
- `AudioPlayer` 自维护播放状态、进度、倍速，导致与业务状态脱节。
- `InputStatusSection` 直接操作 prompt 历史记录 localStorage，缺少统一来源。
- `Toast` 通过 `window.__addToast` 暴露全局 API，生命周期与 SSR 支持较弱。
- `ThemeProvider` 使用 Context，但仍手动操作 DOM 与 localStorage，可迁移到统一的 UI store。

## 状态域概览
| 状态域 | 责任范围 | 主要数据 | 典型读取方 | 持久化策略 |
| --- | --- | --- | --- | --- |
| 配置（Config） | API 访问与播放参数 | `apiConfig`、`version`、校验信息 | Home、Config、用户偏好同步 | `persist` 写入 localStorage |
| 用户（User） | 用户档案与偏好 | `userInfo`、`isLoading`、`error` | Home、后续扩展页面 | 运行时缓存，可联动 Config/UI |
| 故事（Story） | 故事情节上下文 | `inputText`、`segments`、加载标记 | Home、StoryViewer | 运行时 |
| 播放（Playback） | 播放器实时状态 | `isPlaying`、`remainingMinutes`、`progress` | Home、AudioPlayer | 运行时 |
| 预加载（Preload） | 下一段故事/音频缓存 | `preloadedStory`、`audioUrl`、重试状态 | Home | 运行时 |
| 提示词历史（PromptHistory） | Prompt 列表与排序 | `items`、`sortMode` | InputStatusSection、HistoryRecords | `persist` + localStorage |
| 全局 UI（UI/Theme/Toast） | Toast 队列、主题偏好等横切状态 | `toasts`、`theme`、`useSystemTheme` | 任意组件 | Toast 内存态、主题持久化 |

> 采用“一个状态域一个 store”的拆分方式，降低耦合并便于懒加载或服务端注水。

## 状态类型改造建议

### API 配置状态（Config）
#### 依赖分析
- **数据来源**：`localStorage` 中的 `apiConfig`；`DEFAULT_API_CONFIG`、`CURRENT_CONFIG_VERSION`、`isValidConfig` 常量。
- **数据消费者**：Home 页的故事生成与播放流程、Config 页表单、用户偏好写回。
- **外部依赖**：`trackEvent` 埋点、`Toast` 反馈、`fetchAudio`/`generateStory`/`continueStory` 请求均依赖最新配置。

#### Store 设计
- **状态**：`apiConfig`、`isLoaded`、`loadError`。
- **派生**：`isConfigValid`、`missingFields`（用于决定是否跳转配置页或展示提示）。
- **动作**：
  - `hydrateFromStorage()`：读取持久化数据，校验版本号，不合法时回退到默认值。
  - `update(partial)`：局部更新并写回 localStorage，同步版本号。
  - `resetToDefault()`：恢复默认配置。
  - `applyUserPreferences(preferences)`：供用户 store 写入播放时长、主题等偏好。
- **实现示例**：
  ```ts
  // stores/configStore.ts
  import { create } from 'zustand';
  import { devtools, persist } from 'zustand/middleware';
  import { APIConfig } from '@/types/types';
  import { DEFAULT_API_CONFIG, CURRENT_CONFIG_VERSION, isValidConfig } from '@/app/config/home';

  interface ConfigState {
    apiConfig: APIConfig;
    isLoaded: boolean;
    loadError?: string;
    hydrateFromStorage: () => void;
    update: (partial: Partial<APIConfig>) => void;
    resetToDefault: () => void;
    isConfigValid: () => boolean;
    applyUserPreferences: (preferences: Partial<APIConfig>) => void;
  }

  export const useConfigStore = create<ConfigState>()(
    devtools(
      persist(
        (set, get) => ({
          apiConfig: DEFAULT_API_CONFIG,
          isLoaded: false,
          hydrateFromStorage: () => {
            const stored = get().apiConfig;
            if (!stored.version || stored.version !== CURRENT_CONFIG_VERSION || !isValidConfig(stored)) {
              set({ apiConfig: DEFAULT_API_CONFIG });
            }
            set({ isLoaded: true });
          },
          update: (partial) => set({ apiConfig: { ...get().apiConfig, ...partial } }),
          resetToDefault: () => set({ apiConfig: DEFAULT_API_CONFIG }),
          isConfigValid: () => isValidConfig(get().apiConfig),
          applyUserPreferences: (preferences) => set({ apiConfig: { ...get().apiConfig, ...preferences } }),
        }),
        { name: 'api-config' }
      )
    )
  );
  ```

### 用户状态（User）
#### 依赖分析
- **数据来源**：`fetchUserInfo` API。
- **数据消费者**：Home 页头部显示、主题切换、播放时长同步；未来个人中心等页面。
- **外部依赖**：写入 Config store（应用偏好）、Ui/Theme store（切换主题）、Toast（错误提示）。

#### Store 设计
- **状态**：`userInfo`、`isLoading`、`error`、`lastFetched`。
- **动作**：
  - `fetchUserInfo()`：拉取用户资料并联动 Config/Theme store，失败时通知 UI store 弹 Toast。
  - `refresh()`：对外暴露的强制刷新接口，重置错误与时间戳。
  - `clear()`：用户退出或强制重置时调用。
- **实现要点**：
  - 使用 `AbortController` 或请求 id 防止重复写入。
  - 将播放时长、主题偏好通过 `applyUserPreferences` 写入 Config store，并触发 Ui store 切换主题。

### 故事生成状态（Story）
#### 依赖分析
- **数据来源**：`generateStory`、`continueStory` API 调用；用户输入；提示词历史选取。
- **数据消费者**：Home 页主流程、`StoryViewer`。
- **外部依赖**：读取 Config store 获取模型/密钥；向 Playback/Preload store 通知播放进度；更新 PromptHistory store。

#### Store 设计
- **状态**：`inputText`、`segments`（数组）、`isFirstStoryLoading`、`isContinuing`、`lastError`。
- **动作**：
  - `startSession(prompt)`：设置输入、清空旧故事，触发首段生成。
  - `appendSegment(segment)`：生成成功后追加。
  - `setLoadingState(flags)`：区分首段与续写状态。
  - `reset()`：终止播放或重新开始时调用。
- **实现要点**：
  - 将 `generateFirstStory`、`continueStory` 的异步流程放入 store，成功后调用 Playback store 的 `markSessionStart()`。
  - Story store 内部记录请求 id，避免过期响应覆盖。
  - 生成成功时调用 PromptHistory store 的 `upsert(prompt)`。

### 播放器状态（Playback）
#### 依赖分析
- **数据来源**：`AudioPlayer` 组件事件、系统时间（倒计时）、Config store 中的播放时长。
- **数据消费者**：Home 页倒计时展示、AudioPlayer UI、埋点逻辑。
- **外部依赖**：读取 Story store 判断是否还有故事；与 Preload store 协作决定下一段来源；使用 Config store 的 `playDuration`。

#### Store 设计
- **状态**：`isPlaying`、`firstPlayStartTime`、`remainingMinutes`、`currentTime`、`duration`、`playbackRate`。
- **动作**：
  - `startPlayback()` / `pausePlayback()`：供 AudioPlayer 和业务流程直接调用。
  - `markSessionStart()`：记录首段播放时间并初始化倒计时。
  - `updateProgress({ currentTime, duration })`：AudioPlayer `timeupdate` 时写入。
  - `tickRemaining(now)`：由 store 内定时器触发，<=0 时自动暂停。
  - `reset()`：播放完成或重置时清理。
- **实现要点**：
  - 在 store 内保存 `setInterval` 引用，组件只需订阅 `remainingMinutes`。
  - 暴露格式化倒计时 selector，减少组件重复计算。
  - 在 `pausePlayback` 时同步写入 `isPlaying`，避免 UI 与实际状态不一致。

### 预加载状态（Preload）
#### 依赖分析
- **数据来源**：Story store 的内容、`continueStory`、`fetchAudio` 请求结果、Playback store 的 near-end/ended 事件。
- **数据消费者**：Home 页预加载状态展示、播放结束后的自动续播。
- **外部依赖**：读取 Config store（请求参数）、Story store（当前故事文本）、Playback store（剩余播放时间）。

#### Store 设计
- **状态**：`isLoading`、`retryCount`、`preloadedStory`、`preloadedAudioUrl`、`error`、`lastRequestId`。
- **动作**：
  - `requestPreload()`：串行续写与音频生成，根据 `retryCount` 控制退避策略。
  - `consumePreload()`：播放下一段时返回缓存并清空。
  - `recordError(message)`、`reset()`：暴露给 UI 显示与业务重置。
- **实现要点**：
  - 使用 `lastRequestId` 或 `AbortController` 避免旧请求污染状态。
  - 重试逻辑（例如固定 5 秒）在 store 内实现，组件仅触发一次。
  - 与 Playback store 协作为 near-end 事件的默认处理逻辑。

### 提示词历史状态（PromptHistory）
#### 依赖分析
- **数据来源**：`localStorage` 中的历史记录、用户手动保存/删除操作。
- **数据消费者**：`InputStatusSection` 快速入口、`HistoryRecords` 弹窗。
- **外部依赖**：与其他 store 耦合较弱，仅 Story store 会写入使用记录。

#### Store 设计
- **状态**：`items: PromptHistoryItem[]`、`sortMode`。
- **动作**：
  - `hydrate()`：初始化时读取 localStorage，剔除超过 30 天的记录。
  - `upsert(prompt)`：更新使用次数与时间。
  - `remove(prompt)`：用户删除记录时调用。
  - `setSortMode(mode)`：切换排序方式并重新排序。
- **实现要点**：
  - 使用 `persist` 包装自定义 storage，解析失败时回退默认值。
  - 提供 `selectSortedItems()` 以减少组件层排序逻辑。

### 全局 UI 状态（UI/Theme/Toast）
#### 依赖分析
- **数据来源**：用户偏好、系统主题事件、业务层触发的提示信息。
- **数据消费者**：`ThemeProvider`（或其替代实现）、`Toast` 容器、潜在的全局 Modal。
- **外部依赖**：`document.documentElement`、`meta[name="theme-color"]`、`window.matchMedia` 等浏览器 API。

#### Store 设计
- **Toast 队列**：维护 `{ id, message, type, duration }[]`，提供 `pushToast`、`dismissToast`、`clearAll`，替换当前 `window.__addToast` 方案。
- **主题设置**：`theme`、`systemTheme`、`useSystemTheme`，动作包含 `toggleTheme()`、`applySystemTheme(theme)`，在 store 或订阅器中同步 DOM 属性、localStorage、cookie。
- **其他 UI**：预留 `modals`、`loadingOverlay` 等字段，统一管理全局 UI。
- **实现要点**：
  - 将现有 `ThemeProvider` 改造成消费 store 的轻量组件，负责将状态写入 DOM。
  - Toast 容器保持客户端渲染，store 输出纯数据，组件负责动画与生命周期。

## 副作用与数据流编排
- **统一 orchestrator**：在 `app/services/storyFlow.ts` 内封装故事播放流程：
  1. 调用 `storyStore.startSession` → 等待首段生成 → `playbackStore.markSessionStart` 并触发播放。
  2. `AudioPlayer` 事件（play/pause/near-end/ended）分别调度 Playback、Preload store。
  3. `preloadStore.requestPreload` 统一处理续写与音频生成，可根据 Playback 状态决定是否立即播放。
  4. 组件层只订阅 store 状态并渲染，副作用集中在 orchestrator 与各 store。
- **定时器托管**：Playback store 内维护剩余时长 `setInterval`，订阅 Config store 的 `playDuration` 自动重建。
- **Toast 统一入口**：所有异常通过 Ui store 的 `pushToast` 上报，便于后期换弹框方案。
- **持久化监听**：使用 `subscribeWithSelector` 监听关键字段变化（如播放时长变更）触发二次副作用（重置倒计时、上报埋点）。

## 实施步骤（建议迭代交付）
1. **基础设施**：安装 `zustand`，在 `stores/` 目录落地共用工具（`createSelectors.ts`、`typed-hooks.ts` 等）。
2. **配置与用户迁移**：实现 `useConfigStore`、`useUserStore`，重构 Home/Config 页以消费 store，并移除重复的 localStorage 操作。
3. **故事与播放迁移**：实现 `useStoryStore`、`usePlaybackStore`、`usePreloadStore`，在 orchestrator 中串联生成与播放逻辑。
4. **UI 层改造**：让 AudioPlayer、InputStatusSection、Toast、ThemeProvider 改为读取对应 store，删除 `window.__addToast` 等全局变量。
5. **提示词历史迁移**：实现 `usePromptHistoryStore` 并在相关组件中使用。
6. **清理与回归**：移除旧的 `useState`/`useRef` hack，补充 store 的单元测试与关键路径的集成验证。

## 风险与注意事项
- **Next.js SSR**：store 仅在客户端执行；如需服务端预取，可使用 `zustand/vanilla` 搭配 `useStore`，或在 Server Component 传递初始数据。
- **持久化兼容**：`persist` 读写 localStorage 时需捕获 JSON 解析异常，回退默认值避免崩溃。
- **异步竞态**：播放过程中可能同时触发多个续写请求，需要在 Story/Preload store 中使用 `AbortController` 或 `requestId` 控制。
- **DOM 副作用**：主题、Toast 等仍需操作 DOM，应在 store 中判断 `typeof window !== 'undefined'`。
- **类型安全**：为每个状态域定义独立的 `State`、`Actions` 接口，必要时提供 selector 工具减少泛型重复。

## 后续工作建议
- 为关键 store 编写单元测试（`vitest`/Jest），覆盖成功、失败、持久化场景。
- 建立 Storybook 或 Playwright 场景，验证播放器与预加载在 store 驱动下的交互。
- 抽象埋点 Hook，订阅 store 变化后统一上报，减少组件内显式的 `trackEvent` 调用。
- 若未来需要多实例播放器，可将 Playback store 升级为基于 `id -> state` 的字典结构，Zustand 亦能支撑。
