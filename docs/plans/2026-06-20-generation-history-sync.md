# 生成/播放历史上云 实施计划

> 配套 spec：[2026-06-20-generation-history-sync](../specs/2026-06-20-generation-history-sync.md)。复用前两块基建。
> 测试/提交约定同前：无测试框架，以 lint/tsc/build + 浏览器验证为准；本块一个 coherent commit 收尾。

**Goal:** 登录用户生成的故事入库（提示词+正文+音色+时间），提供历史浏览/回放（重合成）/删除；登录专属，复用登录态编排/登出清理。

---

## GH-1: 模型 + 迁移
- [ ] schema.prisma 加 `GenerationHistory` + `User.generationHistory` 反向关系（见 spec）。
- [ ] `DATABASE_URL="file:./dev.db" npx prisma migrate dev --name add_generation_history` + `prisma generate`。
- [ ] 验证 dev.db 出现 `GenerationHistory` 表；tsc。

## GH-2: schema / service / router / client
- [ ] `lib/trpc/schemas/generationHistory.ts`：`recordInputSchema {prompt:1..2000, storyText:1..20000, voiceId?:string}`、`removeInputSchema {id:int}`、`generationHistoryDtoSchema {id,prompt,storyText,voiceId,createdAt:string}` + 类型。
- [ ] `lib/server/generationHistory.ts`：`toDto`；`listGenerationHistory(userId)` 取最近 50（desc）；`recordGenerationHistory(userId,{prompt,storyText,voiceId})` insert → 裁剪保留最近 100（删除 id 不在最近 100 的行）→ 返回 DTO；`removeGenerationHistory(userId,id)` deleteMany where id+userId。
- [ ] `lib/trpc/routers/generationHistory.ts`：list/record/remove（authed），注册到 `routers/index.ts`。
- [ ] `lib/client/generationHistory.ts`：fetchMyGenerations/recordMyGeneration/removeMyGeneration。
- [ ] 验证 tsc + build。

## GH-3: generationHistoryStore（新）
- [ ] `stores/generationHistoryStore.ts`：state `{records:GenerationRecord[], syncEnabled:boolean}`；`initForUser`（list→set, in-flight 去重）、`record(prompt,storyText,voiceId)`（!syncEnabled return；server record→prepend DTO；catch toast）、`remove(id)`（乐观移除+server；catch toast）、`reset()`。无持久化。
- [ ] 验证 tsc。

## GH-4: 业务接线（记录 + 回放 + 编排）
- [ ] chatFlow `executeChatStream`：算 `triggerPrompt`（context 中最后一条 user.content）；`onComplete` audioUrl 分支 story_finish 后调 `useGenerationHistoryStore.getState().record(triggerPrompt, generatedContent, voiceId)`。
- [ ] storyFlow 新增 `replayGeneration(record)`：`resetStoryFlow()`→`fetchAudio(record.storyText, record.voiceId||配置voiceId, speed)`→`startStoryPlayback('replay-'+record.id, audioUrl)`。
- [ ] player 页：登录态 `initForUser()`（与提示词历史同一 effect 内按 isLogin 调）。
- [ ] UserSection 登出追加 `resetGenerationHistory()`。
- [ ] 验证 tsc。

## GH-5: UI 弹窗 + 入口
- [ ] `app/(main)/player/components/GenerationHistory/index.tsx`（+ module.scss）：沿用 Modal/useModal；列表项=提示词+正文摘要+时间，操作=回放（调 replayGeneration 并关弹窗）+删除（store.remove）；未登录空态"登录后查看生成历史"。`forwardRef` 暴露 showModal。
- [ ] InputStatusSection 增加"生成历史"按钮 + 挂载 GenerationHistory（ref 控制）。
- [ ] 验证 tsc + build。

## GH-6: 回归 + 浏览器验收 + code review + 提交
- [ ] lint/tsc/build。
- [ ] 浏览器：登录生成→历史出现→回放→删除→账号切换隔离→访客空态。
- [ ] code review（/code-review）。
- [ ] 清理测试账号；提交。

---

## 自检：Spec 覆盖
| Spec | 任务 |
|------|------|
| 不存音频/正文重合成 | GH-4 replayGeneration |
| 表 + 50/100 限制 | GH-1/GH-2 |
| store 登录专属 | GH-3 |
| 记录时机 onComplete | GH-4 |
| UI 浏览/回放/删除 | GH-5 |
| 登出清理 | GH-4 |
| 验收 1-6 | GH-6 |

---

## 实施记录（as-built：浏览器测试发现并修复的两个 bug）

UI 联调中发现回放触发了同一根因的两个问题，均已修复并复测：

1. **回放触发预加载续写**：`replayGeneration` 复用 `startStoryPlayback` 会 `markSessionStart` 起带倒计时的会话；回放音频很短，播完时 `remainingMs` 仍 >0，`handleSegmentEnded` 找不到下一段便 `requestPreload → beginChatStream('请继续故事')` 自动续写无关内容。
   **修复**：`playbackStore` 新增 `isOneShot` 标志（`markSessionStart(..., { oneShot })`）；`replayGeneration` 以 `oneShot:true` 启动；`handleSegmentEnded`/`handleNearEnd` 在 `isOneShot` 时停止、不续写。

2. **预加载续写被记入生成历史**：记录点在 `chatFlow.onComplete`，对所有故事生成（含预加载的 `请继续故事`）都记录，导致历史被大量 `请继续故事` 污染（正常播放也会）。
   **修复**：`beginChatStream(content, { recordHistory })` 默认 `true`；`preloadStore` 续写传 `false`；`executeChatStream` 仅在 `recordHistory` 时记录。仅用户主动发起的生成入历史。

复测（登录 ghuser）：回放仅 `tts.synthesize` 一次、**无** `agent.interact`、历史不新增 `请继续故事`；音频播完即止。
