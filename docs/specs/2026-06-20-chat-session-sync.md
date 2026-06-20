# 账号体系对接（四）：单会话聊天持久化

> 范围：账号数据绑定大任务的**第四块（收官）**。持久化用户的单条聊天会话，登录后跨设备/刷新恢复。
> 原则：复用前三块基建——服务端为权威源、全局登录初始化、登出清理；登录专属。

---

## 背景与目标

现状：`chatStore` 是单个 `messages[]` 数组（一条对话线，有"清空"按钮），**纯内存、无持久化**，刷新即丢。消息经 `dispatch` 原地变更：`sending → delivered`；`stream.fail` 移除助手占位并把用户消息标记 `failed`。

约束（同前几块）：故事 `storyCard.audioUrl` 是临时 blob URL，**不可持久化**——恢复后故事卡片靠正文重合成播放。

目标：登录用户的当前会话以服务端为准持久化，刷新/换设备恢复；访客维持内存。

---

## 关键决策（已与需求方确认）

| 决策 | 选择 |
|------|------|
| 会话模型 | **单条持久会话**（非多会话列表）。"清空"= 开始新会话。 |
| 持久化策略 | **防抖快照 replace**（非逐条 append）：消息稳定后整条替换服务端。单会话、量有限，最简最稳，无 id 对账。 |
| 保存内容 | 仅**完成态**（`delivered`/未设状态）、**非 summary** 消息；`storyCard.audioUrl` 置空不存。 |
| 音频 | 只存 `storyText`，恢复后故事卡片重合成播放（复用 oneShot 一次性播放）。 |
| summary | 派生内容**不持久化**，恢复后按需重新触发。 |
| 访客 | 登录专属，访客内存（刷新即丢）。 |
| 清空 vs 登出 | 「清空」清服务端（保存空快照即清空，无需独立 clear 接口）；「登出」仅清本地、**不动服务端**（取消在途保存 + 关同步）。 |

---

## 数据模型层（需迁移）

```prisma
model ChatMessage {
  id        Int      @id @default(autoincrement())
  userId    Int
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  /// 会话内顺序
  position  Int
  /// 前端消息 id
  messageId String
  role      String
  content   String
  /// JSON 序列化的 parts（storyCard 的 audioUrl 已置空）
  parts     String?
  /// Agent 类型（story_agent/chat_agent/guidance_agent 等）
  agentType String?
  /// 前端 createdAt ISO 字符串（展示用）
  createdAt String?

  @@index([userId, position])
}
```

`User` 增加反向关系 `chatMessages ChatMessage[]`。需迁移并应用到 dev.db。

DTO：`{ messageId, role, content, parts?: MessagePart[], agentType?, createdAt? }`（parts 由服务端解析回对象）。

---

## 接口设计（tRPC）

新增 `chat` router（全 `authedProcedure`），注册到根 router：

| Procedure | 类型 | 说明 |
|-----------|------|------|
| `getConversation` | query | 按 `position` 升序返回用户会话消息 DTO[]。 |
| `saveConversation` | mutation, input `{ messages: [...] }` | 事务：`deleteMany(userId)` + `createMany`（按数组下标写 `position`）。空数组即清空。 |

服务抽到 `lib/server/chatConversation.ts`；schema 置于 `lib/trpc/schemas/chatConversation.ts`（消息 shape 宽松校验：role/content 字符串、parts 可选对象数组、agentType/createdAt 可选）；客户端封装 `lib/client/chatConversation.ts`。

---

## 状态管理层（chatStore 改造）

- 新增 `syncEnabled`。
- `initForUser()`：`getConversation` → 由 DTO 构建 `ChatMessage[]`（status=delivered，metadata.agentType）→ set messages + syncEnabled=true；in-flight 去重。**hydrate 不触发保存**。
- `reset()`（登出）：取消在途保存定时器 + `messages=[]`、`syncEnabled=false`、清 inputValue/未读；**不调服务端**。
- 防抖快照保存：闭包 `saveTimer` + `scheduleSave()`，在 `dispatch`/`resetChat`/`resetActiveSession` 末尾调用。定时器触发时：`syncEnabled && 无 sending 消息` → 取完成态非 summary 消息（storyCard.audioUrl 置空）→ `saveConversation`。
- `resetChat`（清空）保持清本地；其后的防抖保存空快照即清服务端。

---

## 业务接线

- **全局登录初始化**：`ConfigInitializer` 登录后调 `chatStore.initForUser`（与生成历史并列）。
- **登出清理**：`UserSection.handleLogout` 追加 `chatStore.reset()`。
- **跨块修复（storyFlow）**：`replayGeneration` 原本 `resetStoryFlow()` 会清空 chat；现 `oneShot` 已防续写，故**移除其 chat 清空**（改为复用一次性合成播放助手），避免回放生成历史时误删持久化会话。
- **恢复后回放**：新增 `playStoryText(storyText)`（合成 + oneShot 播放，不碰 chat）。`StoryCardPart` 在 `audioUrl` 为空（恢复态）时改走 `playStoryText(part.storyText)` 重合成；有 audioUrl 时维持原 `onPlayStory`。

---

## 验收标准

1. 登录用户发若干消息 → 刷新页面 → 会话恢复（含故事卡片文本）。
2. 恢复的故事卡片点击播放 → 按正文重合成并一次性播放（无续写）。
3. 换设备（清 localStorage 后重登）→ 会话一致。
4. 「清空」→ 本地与服务端均清空。
5. 「登出」→ 本地清空但服务端保留；重新登录仍能恢复。
6. 账号切换：A 会话 → 登出 → B 登录看不到 A 的会话。
7. 访客聊天不触发 protected 接口、刷新即丢。
8. 从生成历史回放不会清空已持久化的聊天会话。
9. `yarn lint` / `tsc --noEmit` / `build` 全通过。

---

## 影响范围 / 文件清单

| 文件 | 改动 |
|------|------|
| `prisma/schema.prisma` + 新迁移 | 新增 `ChatMessage` 模型 + User 反向关系 |
| `lib/trpc/schemas/chatConversation.ts` | 新增 message/DTO schema |
| `lib/server/chatConversation.ts` | get/save（事务 replace）|
| `lib/trpc/routers/chatConversation.ts` + `index.ts` | 新增 router + 注册 |
| `lib/client/chatConversation.ts` | 客户端封装 |
| `stores/chatStore.ts` | syncEnabled/initForUser/reset + 防抖快照保存 + 序列化 |
| `components/ConfigInitializer/index.tsx` | 全局登录初始化 chat |
| `app/(main)/setting/components/UserSection/index.tsx` | 登出追加 chat.reset |
| `app/services/storyFlow.ts` | replayGeneration 去 chat 清空 + 新增 playStoryText |
| `app/(main)/chat/components/MessageParts/StoryCardPart.tsx` | 恢复态卡片重合成回放 |
