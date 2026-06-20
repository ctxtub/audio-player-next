# 账号体系对接（三）：生成/播放历史上云

> 范围：账号数据绑定大任务的**第三块**。持久化用户生成的故事，提供历史浏览与回放。
> 原则：复用前两块（配置同步、提示词历史）确立的跨域基建——登录态编排 / 登出清理 / 服务端为权威源。

---

## 背景与目标

现状：用户在播放器页/聊天页生成的故事（正文 + 音频）只活在内存（chatStore 消息、playbackStore），刷新即丢，没有"我的生成历史/作品"概念。

**关键约束（决定设计）**：音频 `audioUrl` 是客户端 `URL.createObjectURL` 产生的**临时 blob URL**（[ttsGenerate.ts](../../lib/client/ttsGenerate.ts)），无法跨会话持久化。TTS 接口按文本即时合成 base64 音频。因此：
- **不存音频**，只存**故事正文**与元数据；
- **回放 = 用存下的正文重新走 TTS 合成并播放**（确定性，无需音频存储）。

目标：登录用户每次生成的故事入库（提示词 + 正文 + 音色 + 时间）；提供历史列表浏览/回放/删除；复用基建。

---

## 关键决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 是否存音频 | **不存，存正文，回放时重合成** | blob URL 临时不可持久化；正文可确定性重合成。 |
| 同步模型 | **服务端为权威源** | 与前两块一致。 |
| 访客 | **登录专属，访客不记录** | 全新"我的作品"概念，契合"访客模式·数据不会保存"；省去新建本地持久化，store 登录态才有数据。访客 UI 显示登录引导空态。 |
| 记录时机 | **故事生成完成时**（chatFlow `onComplete` 的 audioUrl 分支） | 覆盖播放器页与聊天页两条生成路径；非故事的普通对话不记录。 |
| 列表规模 | **返回最近 50 条；插入时裁剪每用户保留最近 100 条** | 约束增长，避免无界。 |
| 记录写入 | **非乐观（后台 fire-and-forget，成功后入列）** | 记录发生在生成完成的后台，用户当时不在看历史；非乐观更简单稳健。删除用乐观。 |

---

## 数据模型层（需迁移）

```prisma
model GenerationHistory {
  id        Int      @id @default(autoincrement())
  userId    Int
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  /// 触发生成的提示词
  prompt    String
  /// 生成的故事正文（回放时据此重合成音频）
  storyText String
  /// 生成时使用的音色（回放优先用它，缺省回落当前配置）
  voiceId   String   @default("")
  createdAt DateTime @default(now())

  @@index([userId, createdAt])
}
```

`User` 增加反向关系 `generationHistory GenerationHistory[]`。需迁移并应用到 dev.db。

DTO：`{ id: number; prompt: string; storyText: string; voiceId: string; createdAt: string /* ISO */ }`。

---

## 接口设计（tRPC）

新增 `generationHistory` router（全 `authedProcedure`），注册到根 router：

| Procedure | 类型 | 说明 |
|-----------|------|------|
| `list` | query | 返回当前用户最近 50 条（createdAt desc）DTO。 |
| `record` | mutation, input `{ prompt, storyText, voiceId? }` | 插入一条；插入后裁剪每用户仅保留最近 100 条；返回新建 DTO。 |
| `remove` | mutation, input `{ id }` | 按 `(id, userId)` 删除。 |

服务逻辑抽到 `lib/server/generationHistory.ts`；schema 置于 `lib/trpc/schemas/generationHistory.ts`；客户端封装 `lib/client/generationHistory.ts`。

---

## 状态管理层（新 generationHistoryStore）

登录专属，无 localStorage 持久化：
- state：`records: GenerationRecord[]`、`syncEnabled: boolean`。
- `initForUser()`：`list` → set records，`syncEnabled=true`；in-flight 去重。
- `record(prompt, storyText, voiceId)`：未登录（`!syncEnabled`）直接返回；否则 server `record` → 成功后 prepend DTO（失败 toast）。
- `remove(id)`：乐观本地移除 + server `remove`（失败 toast）。
- `reset()`：`records=[]`、`syncEnabled=false`。

---

## 业务接线

- **记录**：[chatFlow](../../app/services/chatFlow.ts) `executeChatStream` 捕获触发用户提示词；`onComplete` 故事分支（audioUrl 存在）后调 `useGenerationHistoryStore.getState().record(prompt, storyText, voiceId)`。
- **回放**：[storyFlow](../../app/services/storyFlow.ts) 新增 `replayGeneration(record)`：`resetStoryFlow()` → `fetchAudio(storyText, voiceId, speed)` → `startStoryPlayback('replay-'+id, audioUrl)`。`resetStoryFlow` 已清空 chat，避免回放后自动续播无关内容。
- **编排**：播放器页按登录态 `initForUser()`（登录）；登出在 [UserSection](../../app/(main)/setting/components/UserSection/index.tsx) 追加 `reset()`。

---

## UI

新增 `GenerationHistory` 弹窗组件（沿用 [HistoryRecords](../../app/(main)/player/components/HistoryRecords/index.tsx) 的 `Modal`/`useModal` 模式），在播放器页 `InputStatusSection` 增加"生成历史"入口按钮（与"历史记录"并列）。列表项展示：提示词、正文摘要（前若干字）、时间；操作：点击回放（重合成播放）、删除。未登录显示"登录后查看生成历史"空态。

---

## 验收标准

1. 登录用户生成故事后，"生成历史"出现该条（提示词 + 摘要 + 时间）。
2. 点击历史项 → 重新合成并播放该故事正文。
3. 删除历史项 → 列表与服务端均移除。
4. 账号切换：用户 A 历史 → 登出 → 用户 B 看不到 A 的历史。
5. 访客：不记录，历史视图显示登录引导。
6. 每用户最多保留最近 100 条。
7. `yarn lint` / `tsc --noEmit` / `build` 全通过。

---

## 影响范围 / 文件清单

| 文件 | 改动 |
|------|------|
| `prisma/schema.prisma` + 新迁移 | 新增 `GenerationHistory` + User 反向关系 |
| `lib/trpc/schemas/generationHistory.ts` | 新增 schema/DTO |
| `lib/server/generationHistory.ts` | 新增 list/record(+裁剪)/remove |
| `lib/trpc/routers/generationHistory.ts` + `index.ts` | 新增 router + 注册 |
| `lib/client/generationHistory.ts` | 新增客户端封装 |
| `stores/generationHistoryStore.ts` | 新增 store |
| `app/services/chatFlow.ts` | 生成完成记录历史 |
| `app/services/storyFlow.ts` | 新增 replayGeneration |
| `app/(main)/player/index.tsx` | 登录态 initForUser |
| `app/(main)/player/components/GenerationHistory/*` | 新增弹窗组件 |
| `app/(main)/player/components/InputStatusSection/index.tsx` | "生成历史"入口 |
| `app/(main)/setting/components/UserSection/index.tsx` | 登出追加 reset |
