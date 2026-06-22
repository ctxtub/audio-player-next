# player 生成能力并入 chat（消除重复入口）

> 范围：UX/架构整合。story 生成能力当前同时存在于 `/chat` 与 `/player` 两页（重复）。本块把生成统一收归 chat，/player 退化为**纯播放 + 历史**视图，顺带闭环账号绑定遗留项 2（player 生成故事会清空已持久化聊天会话）。

## 背景与动机

应用为单套 LangGraph Agent（supervisor 路由 story/chat/guidance），`/chat` 与 `/player` 共用同一个 `chatStore`。两页都提供 story 生成入口：

- **chat** `ChatLayout`：`InputArea` → `beginChatStream()`（已支持 story/chat/guidance 意图路由），`MessageArea` 渲染 storyCard，播放走全局 `FloatingPlayer`。生成历史已在 `chatFlow.ts:123` 记录。
- **player** `InputStatusSection`：文本框 + 「生成故事」+ 题材快捷按钮 → `beginStorySession()` → `resetStoryFlow()` → `resetChat()`（**清空并云端清除聊天会话**），同时 `promptHistory.addOrUpdate()` 记提示词历史。

**问题**：

1. **生成能力重复**：同一能力放在两页，维护双份、体验割裂。
2. **静默数据丢失（遗留项 2）**：登录用户在 chat 有对话后，去 player 生成故事会清空其聊天会话（含云端）。
3. **提示词历史记录点错位**：`promptHistory.addOrUpdate` 仅在 player 输入处调用；生成一旦移出 player，提示词历史将不再增长。

## 目标

1. **生成只在 chat**：移除 /player 的 story 生成入口，消除重复。
2. **/player 留作纯播放 + 历史**：保留播放面板、音频播放器、生成历史与提示词历史入口。
3. **承接被移走的能力**：提示词历史记录搬入 chat 的生成路径；提示词历史「选一条」改为跳转 chat 预填并自动发送。
4. **闭环遗留项 2**：player 不再 `resetChat`，聊天会话不再被静默清空。
5. **行为不回退**：chat 生成/播放、生成历史、悬浮播放器等既有能力不变。

## 非目标（YAGNI）

- 不重做 chat 的 UI（已满足）。
- 不删除 /player 页或其播放面板（用户明确保留 player 作播放视图）。
- 不动 `generationHistory.record`（chat 已在记）。
- 不触碰遗留项 1（聊天 summary 持久化）——独立小修，单独提交。

## 方案对比

| 方案 | 描述 | 取舍 |
|---|---|---|
| **A 减法整合：player 去生成、留播放+双历史，提示词记录搬入 chat（采用）** | /player 仅移除生成输入；两历史入口留在 player；提示词历史在 chat story-finish 处记录；提示词「选一条」跳 chat 自动发送 | ✅ 直接匹配「player=播放+历史」诉求；改动以删减为主、风险低；提示词历史语义更准（只记真正生成了故事的提示词）。⚠️ 新增一处跨页自动发送信号 |
| B 提示词历史也迁到 chat、player 只留生成历史 | 语义按「生成相关→chat、回放相关→player」彻底分家 | ❌ 需在 chat 新增历史入口 UI，改动更大；与用户「player 留双历史」的表述不符 |
| C 提示词历史改为只读、不再记录 | 不搬记录点，提示词历史成 legacy | ❌ 保留入口却停止增长，体验割裂 |

## 设计

### A. /player（减法：去生成，留播放 + 历史）

- **移除**（`app/(main)/player/index.tsx` 与 `InputStatusSection`）：故事文本框、「生成故事」按钮、题材快捷按钮（自然冥想/奇幻童话/…）、`beginStorySession`/`handleInputSubmit`/`storyInputText` 派生、`addHistoryRecord` 调用、player 内对 `resetStoryFlow` 的引用。
- **保留**：`PlaybackStatusBoard`、`GenerationPreview`、`AudioPlayer`；以及「历史记录」（提示词历史）与「生成历史」两入口 + 弹窗。
- `InputStatusSection` 瘦身为**历史操作条**：仅渲染两个历史入口按钮 + `HistoryRecords` / `GenerationHistory` 弹窗（去掉所有生成相关 props 与状态）。
- 保留 player 既有的「配置无效 → 跳 /config」守卫。

### B. chat（承接被移走的能力）

- **提示词历史记录搬入 chat**：在 `app/services/chatFlow.ts` 的 story-finish 路径（[chatFlow.ts:123](../../app/services/chatFlow.ts) 处 `generationHistory.record` 旁），追加 `usePromptHistoryStore.getState().addOrUpdate(triggerPrompt)`，**同受 `recordHistory` 闸门**（仅用户主动发起、真正生成了故事时记；预加载续写不记）。
- **跨页自动发送**：`chatStore` 增加瞬态字段 `pendingAutoSend: string | null` + setter（不入持久化快照、不参与 `toSnapshot`）。
  - 提示词历史「选一条」（player）：`setPendingAutoSend(prompt)` + `router.push('/chat')`。
  - `ChatLayout` 挂载副作用：若 `pendingAutoSend` 非空，则 `setInputValue(pendingAutoSend)` → 复用既有 `handleSubmit(pendingAutoSend)`（含 `ensureUnlocked` + 错误兜底）→ 清空 `pendingAutoSend`（仅消费一次）。

### C. 清理 / 遗留项 2 闭环

- `beginStorySession`（仅 player 用过）成死代码 → 从 `app/services/storyFlow.ts` 删除。
- `resetStoryFlow` 仍由 chat「清空」按钮使用 → 保留不动；因 player 不再调用，「player 生成清空聊天」行为消失，**遗留项 2 闭环**。

## 数据流（整合后）

```
用户输入（仅 chat InputArea）
  → beginChatStream(prompt)
     → supervisor 路由 story → 生成正文 + TTS
     → 首次自动 startStoryPlayback（全局 FloatingPlayer 播放）
     → recordHistory 时：generationHistory.record + promptHistory.addOrUpdate
/player：读取全局 playback/generation 状态展示，提供历史入口；选提示词 → 跳 chat 自动发送
```

## 影响面

- 改：`app/(main)/player/index.tsx`、`app/(main)/player/components/InputStatusSection/index.tsx`（瘦身）、`app/services/chatFlow.ts`、`app/services/storyFlow.ts`、`stores/chatStore.ts`、`app/(main)/chat/components/ChatLayout/index.tsx`。
- 可能涉及 `InputStatusSection/index.module.scss`（移除生成相关样式）。
- 无接口 / 数据模型 / 新依赖改动。

## 验收标准

1. 三道门全绿（lint / tsc / build）。
2. /player 无生成入口；仍有播放面板 + 音频播放器 + 两历史入口。
3. 在 chat 生成故事正常：正文 + 音频播放 + 生成历史 + **提示词历史新增一条**。
4. /player「历史记录」选一条 → 跳 /chat、输入框预填该提示词并**自动发送**生成。
5. 在 chat 有对话后切到 /player（不再有生成动作）→ 聊天会话**不被清空**（遗留项 2 闭环）。
6. `beginStorySession` 已无引用并删除；`grep` 无残留。
</content>
