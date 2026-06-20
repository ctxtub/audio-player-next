# 单会话聊天持久化 实施计划

> 配套 spec：[2026-06-20-chat-session-sync](../specs/2026-06-20-chat-session-sync.md)。复用前三块基建。
> 约定同前：无测试框架，以 lint/tsc/build + 浏览器验证为准；一个 coherent commit 收尾。

**Goal:** 单条聊天会话随账号持久化（防抖快照 replace），刷新/换设备恢复，故事卡片恢复后重合成回放；登录专属，复用全局登录初始化/登出清理。

---

## CS-1: 模型 + 迁移
- [ ] schema.prisma 加 `ChatMessage` 模型（position/messageId/role/content/parts/agentType/createdAt）+ `User.chatMessages` 反向关系。
- [ ] `migrate dev --name add_chat_message` + `prisma generate`；验证表 + users 不变。

## CS-2: schema / service / router / client
- [ ] `lib/trpc/schemas/chatConversation.ts`：`chatMessageInputSchema {messageId, role, content, parts?: z.array(z.record(z.string(), z.unknown())), agentType?, createdAt?}`；`saveConversationInputSchema {messages: array}`；`ChatMessageDTO` 类型。
- [ ] `lib/server/chatConversation.ts`：`getConversation(userId)` 按 position 升序 → DTO（parts JSON.parse）；`saveConversation(userId, messages)` 用 `prisma.$transaction([deleteMany, createMany(position=index, parts JSON.stringify)])`。
- [ ] `lib/trpc/routers/chatConversation.ts`：getConversation/saveConversation（authed）；注册 `chat: chatConversationRouter`。
- [ ] `lib/client/chatConversation.ts`：fetchMyConversation/saveMyConversation。
- [ ] 验证 tsc + build。

## CS-3: chatStore 改造
- [ ] base state 加 `syncEnabled: boolean`。
- [ ] actions 加 `initForUser(): Promise<void>`、`reset(): void`。
- [ ] 闭包：`saveTimer`、in-flight `userInitPromise`、`toSnapshot(messages)`（filter status ∈ {delivered, undefined} 且 agentType≠summary_agent；map → {messageId, role, content, parts(storyCard.audioUrl→''), agentType, createdAt}）、`scheduleSave()`（防抖 1s；触发时 syncEnabled && 无 sending → saveMyConversation(toSnapshot)）。
- [ ] `dispatch`/`resetChat`/`resetActiveSession` 末尾调 `scheduleSave()`。
- [ ] `initForUser`：syncEnabled 已 true 则跳过；`fetchMyConversation` → map DTO → ChatMessage[]（id=messageId, status:'delivered', metadata:agentType?{agentType}:undefined）→ set messages+syncEnabled。
- [ ] `reset`：clearTimeout(saveTimer)、set messages=[]、inputValue=''、hasUnviewedResponse=false、syncEnabled=false。
- [ ] 验证 tsc。

## CS-4: 编排 + storyFlow 跨块修复 + 恢复回放
- [ ] `ConfigInitializer`：登录后 `void chatStore.initForUser()`（与生成历史并列 effect）。
- [ ] `UserSection.handleLogout`：追加 `resetChat()`→ 实为新增 chatStore.reset（登出用）。注意用 `reset()` 不是 `resetChat()`。
- [ ] `storyFlow`：抽 `synthesizeAndPlayOnce(storyText, voiceId, messageId)`（fetchAudio + startStoryPlayback oneShot）；`replayGeneration` 改为调它（**移除 resetStoryFlow**，oneShot 已防续写）；新增 `playStoryText(storyText)`。
- [ ] `StoryCardPart`：`handlePlay` 中 `part.audioUrl` 为空 → `void playStoryText(part.storyText)`；否则原 `onPlayStory(part.audioUrl)`。
- [ ] 验证 tsc + build。

## CS-5: 回归 + 浏览器验收 + code review + 提交
- [ ] lint/tsc/build。
- [ ] 浏览器：登录发消息→刷新恢复→故事卡片重合成播放→清空（本地+服务端）→登出（本地清、服务端留）→重登恢复→账号隔离→生成历史回放不清空会话。
- [ ] /code-review。
- [ ] 清理测试账号；提交。

---

## 自检：Spec 覆盖
| Spec | 任务 |
|------|------|
| ChatMessage 表 | CS-1 |
| get/save(replace 事务) | CS-2 |
| 防抖快照 + 序列化 | CS-3 |
| initForUser/reset | CS-3 |
| 全局初始化/登出清理 | CS-4 |
| 回放不清会话 + playStoryText | CS-4 |
| 恢复态卡片重合成 | CS-4 |
| 验收 1-9 | CS-5 |

---

## 实施记录（as-built）

- **跨块修复**：`replayGeneration` 原 `resetStoryFlow()` 会清空 chat，随会话持久化会误删服务端会话。因 `oneShot` 已防续写，抽 `synthesizeAndPlayOnce`（不碰 chat）供 `replayGeneration` 与新 `playStoryText` 复用；并在其中 `generationStore.reset()` 避免恢复态卡片误显生成动效。
- **code review（inline，high effort）**：无高危 bug。三条低风险记录：① 从播放器生成故事会替换持久化会话（单会话既有行为，符合设计）；② 首次登录 `initForUser` 未完成前发消息的极窄竞态可能被恢复覆盖（与其余块 init 模式一致，概率极低）；③ 单条消息超 content 上限会使整次快照保存失败——已把上限 20000→50000 加固。
- **浏览器验收**：发真消息→`saveConversation` 防抖 1 次→服务端落库；刷新恢复；恢复态故事卡片重合成播放（仅 `tts.synthesize`，无 `agent.interact`）；清空→本地+服务端清空；登出→服务端保留、重登恢复；账号隔离成立。
