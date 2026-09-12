# stream 完成与 Artifact 完成解耦

功能域：08-创作Artifact

## 用户目标

创作会话中故事正文的完成态仅由显式 `story_complete` 决定，传输层 `done` 只标记送达；新生成链不再写入 Legacy 故事卡片，历史卡片仍可只读展示。

## 范围与边界声明

本场景限定于「stream 事件 → Chat state」的切换语义（Modern Artifact `draft→complete`），严格限定于内容完成层。

**包含的职责**：
- assistant 消息创建即按其 `message.id` 建立 `draft`（`sourceMessageId` 恒等于该 id）
- 流式文本片段追加到同一 `draft`（按 attempt 身份定位，不以「最后一条」归属）
- 显式 `story_complete` 将同一 `draft` 推进为 `complete`（仅表示故事正文 terminal）
- `done` 仅将消息标记为 `delivered`，不改变 Artifact 状态
- 新生成链不再新写 `StoryCardPart`；历史 `StoryCard` 只读渲染保留

**显式排除以下能力**（留后续模块，不在本场景声称）：
- 作品入库与资产创建
- 入库幂等与重试语义
- 音频合成、播放与音频可用性
- 作品库查询、展示与生命周期变更

## 契约验收标准

### 1. 身份定位与冻结语义
- assistant 消息创建时 `message.id = X`，对应 `draft.sourceMessageId === X`。
- 后续 `delta`/`story_complete`/`done`/`fail` 均按 `messageId = X` 定位同一 Artifact；找不到（stale/已清空）一律忽略，不复活、不污染其它 attempt。
- 不再以「messages 最后一条」作为异步回调归属依据。

### 2. story_complete 仅为正文 terminal
- `story_complete` 到达：同一 `draft→complete`，正文采用权威文本覆盖。
- 重复 `story_complete` 到达：同一 attempt 幂等忽略，仍为同一个 `complete`。
- `story_complete` 不改变消息投递状态之外的任何资产含义。

### 3. done 与 complete 正交
- `story_complete → done`：仍是同一个 `complete`，正文与 id 不变。
- `done → story_complete`：`done` 先到不得提前制造任何就绪语义；随后 `story_complete` 仍可将 `draft` 推进为 `complete`。

### 4. 中断与清空隔离
- 流错误/中断：`draft→interrupted`，不出现 `complete`；随后迟到的 `story_complete` 不得覆盖 `interrupted`。
- 新 Attempt B 建立后到达的旧 Attempt A 完成事件：绝不覆盖 B。
- `resetChat`/清空后到达的旧完成事件：绝不复活旧 Artifact，消息列表保持为空。

### 5. 旧写入拆除与只读保留
- 新生成路径不再写入 `StoryCardPart`，不再以 `done`/音频到达隐式拼装故事卡。
- 历史 `StoryCard`（含 `storyText`/`audioUrl`）仍可解码与只读渲染；快照 sanitizer 与播放只读链保留。
- 正式静态 cutover 留后续任务，本场景不断言历史下线。
