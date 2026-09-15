# Artifact Chat UI / Promotion State Surface

功能域：08-创作Artifact

## 用户目标

Chat 里的 Modern Story Artifact 呈现为语义正确、可操作的纯 lifecycle UI：六态（`draft → complete → promoting → ready / promotion_failed`，`draft → interrupted`）均有明确表达；`promotion_failed` 可一键重试保存；`ready` 可进入作品库；正文始终由 Artifact 自身持有，全程无播放、无持久化、无 promotion side effect。

## 范围与边界声明

本场景限定于 Chat Artifact 在内存中的正确呈现（M4-05 功能 UI 接线里程碑），不做最终视觉，不进入实际 playback 能力，不碰 persistence/rehydration（留 M4-06）。

**包含的职责**：
- `StoryArtifactPart` 唯一状态源为 `artifact.status`，正文唯一来源为 `artifact.storyText`（不读全局 generation `phase` / `streamingText`）
- 六态确定性渲染：`draft` 正在创作故事；`complete` 正文完成准备保存；`promoting` 正在保存到作品库；`ready` 已保存到作品库＋查看作品；`promotion_failed` 保存失败可重试保存；`interrupted` 生成已中断
- `promotion_failed` 重试唯一动作 `dispatch({ type: 'promotion.retry', messageId })`（`messageId` 缺失 fail-closed）；无第二套 local loading 状态（store 同步切回 `promoting` 即是反馈）
- `ready` 只做 Library handoff（导航 `/library/${storyWorkId}`，不 fetch、不验音频、不播放、不 mutation）
- `interrupted` 与 `promotion_failed` 明确分家；delivery（`ChatMessage.status`）与 Artifact lifecycle 继续分离
- Modern Artifact playback 预接删除（不是 disable）；`MessageParts` 分发器切断 `storyArtifact` 分支的 `onPlayStory` 透传（通用契约与 Legacy `storyCard` 分支保留）
- Legacy `storyCard` 只读兼容：renderer 可加载、历史行为不变、共享 playback CSS 不删

**显式排除以下能力**（留后续模块，不在本场景声称）：
- 最终视觉（card redesign、动效系统、spacing/Typography tuning、播放态视觉）
- 实际播放入口、audio manifest、session 状态（归 M6/M7；`ready` 绝不 implies 音频可播放）
- 会话持久化与恢复（`toSnapshot` policy、`initForUser` rehydration、刷新时 `promoting` 恢复语义归 M4-06）
- Legacy `storyCard` 最终 cutover（归 M4-08）与旧数据 migration/backfill

## 契约验收标准

### 1. 六态渲染契约（M4-05-01）
- 构造 6 个合法 `StoryArtifact` fixture 逐一渲染不 crash；状态文案符合上表语义；`storyText` 保持可见；`complete` / `promoting` 不得被误称为 `ready`（无“已保存”、无 `/library/:id` CTA）。

### 2. draft 正文归属（M4-05-02）
- `draft` 正文必须来自 `artifact.storyText`；`Artifact A.storyText = "A"` 且全局 generation 文本为 `"B"` 时 UI 只显示 A。静态断言 Modern renderer 不再读取 `useGenerationStore` / `streamingText` / generation phase。

### 3. complete ≠ saved（M4-05-03）
- 正文可读（长文经“查看全文”读全）；表达“正文完成/准备保存”；无“已保存”、无 `/library/:id` CTA、无 retry、无 playback。

### 4. promoting 表面（M4-05-04）
- 显示“正在保存到作品库”；正文仍存在；无 retry、无 ready CTA、无 audio/playback 语义（亦是 retry 点击后的正确反馈态）。

### 5. ready → Library handoff（M4-05-05）
- `status: 'ready', storyWorkId: 123` → “已保存到作品库”＋“查看作品”，目标严格是 `/library/123`；不伴随 play/TTS/`library.create`/audio readiness probe。

### 6. 失败保留 Artifact（M4-05-06）
- `promotion_failed` 下原 `storyText` 完整显示、`sourceMessageId` 不变；显示“保存失败，可重试保存”＋“重试保存” CTA；不得渲染成“故事生成失败”；raw backend error 不直暴露。

### 7. retry 归属（M4-05-07）
- 点击一次“重试保存”，UI 层唯一动作等价于 `dispatch({ type: 'promotion.retry', messageId })`；无 `user.retry`、generation request、`libraryClient.create` 直调、新 assistant id、`sourceMessageId` mutation；`messageId` 缺失 fail-closed（不猜 latest）。

### 8. 双击 exactly-one（M4-05-08）
- 连续快速触发 retry 时 `library.create` 至多 1 个 in-flight（复用 M4-04 `inflightPromotions`＋token＋epoch 防线；M4-05 不自建去重器、不破坏该防线）。

### 9. interrupted 分离（M4-05-09）
- `interrupted` 保留 partial `storyText`、显示生成中断语义；无 promotion retry、无保存 CTA、无 playback CTA；与 `promotion_failed` 文案可分辨。

### 10. Modern 播放纯净度（M4-05-10，blocking）
- `StoryArtifactPart.tsx` 不得出现/import `playStoryText` / `usePlaybackStore` / `usePlaybackProgressStore` / `playbackStore` / `playbackProgressStore` / `audioUrl` / `Pause` / `Headphones` / `generating_audio`；用户可见文案不得再有“播放故事/暂停播放/继续收听/正在生成语音”。

### 11. Legacy 只读兼容（M4-05-11）
- 现有 `storyCard` renderer 仍可加载、历史卡片不报错、未被转写、所需 playback CSS/API 未被误删（正式 cutover 留 M4-08）。

### 12. 架构纯净度（M4-05-12）
- Modern Artifact UI 不得 import `@/lib/server/**` / Prisma / raw tRPC mutation / `libraryClient.create` / `executePromotionCreate` / `storyArtifactPromotion` 执行层 / playback services；允许依赖 ChatArtifact 类型、`useChatStore` dispatch、`StoryViewer`、导航/样式。
