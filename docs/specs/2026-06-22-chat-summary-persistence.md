# 聊天 summary 持久化（恢复后保留上下文锚点）

> 范围：账号绑定遗留项 1 的小修。属一行行为修复（bugfix），不另出 plan。

## 背景与动机

`checkAndSummarize` 在长会话中生成 summary 消息（`agentType: 'summary_agent'`，`parts: [{ type: 'summary' }]`）作为上下文锚点；`conversationMessages()` 以最后一条 summary 为界、只取其后的消息作为请求上下文，从而压缩长会话首请求体积。

但 `toSnapshot`（[stores/chatStore.ts:166](../../stores/chatStore.ts)）的过滤条件 `message.metadata?.agentType !== 'summary_agent'` 把 summary 排除在持久化快照之外。结果：登录用户恢复长会话后，messages 里没有 summary 锚点，`conversationMessages()` 退回**全量历史**作上下文，恢复后的首个请求偏大（与未做 summary 等价）。

## 目标

持久化 summary 消息，使恢复后 `conversationMessages()` 仍能锚定 summary、只取其后上下文。正常无 summary 的会话不受影响。

## 非目标（YAGNI）

- 不改 summary 生成/触发逻辑（`checkAndSummarize` / `summary.update`）。
- 不改持久化 schema（`chatMessageInputSchema` 的 parts/agentType 已宽松，足以容纳 summary）。

## 设计

`toSnapshot` 过滤条件去掉 `&& message.metadata?.agentType !== 'summary_agent'`，即不再排除 summary 消息（仍保留 `status` 完成态过滤与 storyCard 音频置空）。

恢复路径无需改：`initForUser` 已按 `dto.agentType` 还原 `metadata.agentType`、按 `dto.parts` 还原 `parts`，故 summary 恢复后带回 `agentType:'summary_agent'` 与 `summary` part，`conversationMessages()` 的 `findLastIndex(... 'summary_agent')` 即可锚定。summary 只有一条（`summary.update` 以 `oldSummaryId` 替换旧条），不会重复堆积。

## 验收标准

1. 三道门全绿（lint / tsc / build）。
2. 含 summary 的长会话保存后，快照包含该 summary 条（`agentType:'summary_agent'`）。
3. 恢复后 `conversationMessages()` 以 summary 为界截取，不再退回全量历史。
4. 无 summary 的普通会话保存/恢复行为不变。

## 验证结果（as-built · 2026-06-22）

- 三道门全绿。
- 代码推理：`toSnapshot` 去除排除项后 summary（status `delivered`）进入快照；`initForUser` 还原映射已支持 `agentType`/`parts`；`conversationMessages` 锚定逻辑不变。完整长会话→保存→恢复的活体链路需 LLM 触发 summary，未在本环境内跑（dev 无业务数据 + 需模型）。
</content>
