# Artifact History Round-trip / Rehydration

功能域：08-创作Artifact

## 用户目标

Chat Artifact 的内存状态机变为可跨 reload 的历史契约：`ready / promotion_failed / interrupted` 稳定 round-trip；`draft / complete / promoting` 在持久化边界安全降级；非法 Modern Artifact fail-closed；恢复过程纯读、零 `create`、零 generation、零自动 retry，并且绝不影响 await-window 内仍真实存活的本地 attempt。

## 范围与边界声明

本场景限定于 Chat Artifact 历史持久化规范 / Reload 恢复 / 脏数据防线（M4-06 功能里程碑），是独立的 projection / recovery boundary，不改 live 状态机本身。

**包含的职责**：
- Save-side canonicalization：`live store → toSnapshot → history canonicalization → saveMyConversation`；live 内存 `promoting` 仍保持 `promoting`，仅落盘 clone 变 `promotion_failed`（serialize 不得 mutate live store）
- Load-side 防御性 rehydrate：已存在的 `draft / complete / promoting` 或非法 Modern Artifact 在 reload 时得到确定、安全的状态
- 进程边界恢复规则（冻结）：`draft → interrupted`、`complete → promotion_failed`、`promoting → promotion_failed`、`ready → ready`、`promotion_failed → promotion_failed`、`interrupted → interrupted`
- 恢复纯读零副作用：加载历史绝不触发 generation、promotion、Library mutation 或 playback；`initForUser` 仍然是纯 restore，不 save-back，不自动 `promotion.retry`
- 脏数据 fail-closed：`sourceMessageId` mismatch 禁止修复；非法 part 只丢该 part，不删整条 message；无合法 parts 时回 `parts: undefined` 走 content fallback
- 合法 Modern Artifact 恢复后 `message.content = artifact.storyText`（valid Artifact wins）；Legacy `storyCard` 继续只读，不转 `StoryArtifact`
- `initForUser` 只能 normalize 服务端 fetch 结果，await-window 本地消息 untouched

**显式排除以下能力**（留后续模块，不在本场景声称）：
- Live 状态机扩展（M4-01 `ALLOWED_TRANSITIONS` 继续冻结；不得为让 `complete → promotion_failed` 好写而改表）
- History UI relocation（入口位置、布局、抽屉/路由归 M4-07；UI 只消费已 normalize 的 messages）
- Legacy cutover（批量 `storyCard → storyArtifact`、读 legacy 建 `StoryWork`、补 `sourceMessageId`、删 `StoryCardPart` 归 M4-08）
- Delivery persistence policy 重定义（`toSnapshot` 仍只存 `delivered`；`failed` 是否永久保存不在本项改）
- 服务端 `chatConversation.ts` 宽松 parts schema 收紧（服务端继续当用户自有 JSON 存，校验在客户端领域边界做）

## Crash-window 恢复语义（冻结）

| 崩溃窗口 | 持久形态 | Reload 后 | 说明 |
|---|---|---|---|
| generation 中刷新（`draft` 在途，stream transport 已丢失） | `interrupted`（save-side canonicalize；旧历史 `draft` 经 rehydrate 同样降级） | `interrupted`，部分正文保留 | 不可假装继续生成；不得恢复 stream、不得把 message 再置 `sending`、不得启动 generation |
| text `complete` / promotion 未确定时刷新（正文完整但无确认 `StoryWork`） | `promotion_failed`（save-side canonicalize；旧历史 `complete` 经 rehydrate 同样降级） | `promotion_failed`，正文与 frozen promotion snapshot 全保留 | 不能永久显示准备保存、不能自动 `create`、不能假装 `ready`；之后只能由用户显式 `promotion.retry` 走 M2 幂等 reconciliation |
| promotion request 已送出但 response 未回来时刷新（`token / epoch / in-flight slot` 已丢失，旧 settlement ownership 不可信） | `promotion_failed`（save-side canonicalize；旧历史 `promoting` 经 rehydrate 同样降级） | `promotion_failed`，`outcome unknown → 用户显式幂等 retry` | 不恢复为 `promoting`；禁止 `initForUser` 自动 retry；即使 crash 前 create 已提交，重试由 M2 幂等收敛而非 loader 猜成功 |

## 契约验收标准

### 1. Ready exact round-trip（M4-06-01）
- 合法 `ready(storyWorkId = 123)` 走 `serialize → persisted payload → rehydrate` 后 `status / storyWorkId / id / sourceMessageId / storyText / prompt / voice / title / createdAt / updatedAt` 全不变，且 `library.create = 0`、`generation = 0`。

### 2. Promotion failed exact round-trip（M4-06-02）
- 已有 `promotion_failed` 的 `status / error / storyText / sourceMessageId / prompt / voice` 全保留；rehydrate 不 retry（`create = 0`）；恢复后 M4-05 retry 仍可正常 dispatch M4-04 路径。

### 3. Persisted promoting recovery（M4-06-03）
- 服务端 fixture `promoting` 经 `initForUser` 后必为 `promotion_failed`；`library.create = 0`、`promotion kick = 0`、`generation = 0`；不得永久显示正在保存到作品库。

### 4. Persisted complete recovery（M4-06-04）
- 历史 `complete` 恢复为 `promotion_failed`；正文与全部 frozen promotion snapshot 不变；不能自动 `create`；缺 prompt snapshot 也不在 History 层猜 prompt（M4-03 fail-fast 由后续 retry 承担）。

### 5. Persisted draft recovery（M4-06-05）
- 历史 `draft` 恢复为 `interrupted`（deterministic reason `history_reload_interrupted`，不用 `Date.now()` 改 `updatedAt`）；部分正文保留；不得恢复 stream、不得把 message 再置 `sending`、不得启动 generation。

### 6. Stable interrupted compatibility（M4-06-06）
- 服务端已有合法 `interrupted` 必须原样回读（`status / storyText / reason / identity`）；本条只测 decoder，不改变 failed-message save filtering。

### 7. Save-side canonicalization + immutability（M4-06-07，blocking）
- Live `delivered + draft / complete / promoting` 的 `saveMyConversation` payload 分别为 `interrupted / promotion_failed / promotion_failed`；保存完成后 live store 仍为 `draft / complete / promoting`（serializer 不 mutate live state；同一对象连续 serialize 等价）。

### 8. Await-window live attempt isolation（M4-06-08，blocking）
- `initForUser` fetch pending 窗口内本地 `user.submit / story attempt` 进入 `draft / promoting` 后，server resolve 时 server 历史 transient 被 recovery、本地消息保持 live 状态；本地在途 promotion 随后 resolve 仍可正常 `ready`；History normalization 绝不碰 appended local。

### 9. Malformed Artifact fail-closed（M4-06-09）
- 覆盖 `unknown status / ready without storyWorkId / ready storyWorkId <= 0 / non-ready with storyWorkId / empty-invalid`：不 crash 整个 init；非法 part 被拒；`message.content` 保留；无 `create`、无 generation。

### 10. Source ownership corruption（M4-06-10）
- `message.id = B` 但 `artifact.sourceMessageId = A` 时不改 A、不改 B、不 promotion；part fail-closed，原 content 保留；合法 `message.id === sourceMessageId` 完整保留（M2 幂等身份不被改写）。

### 11. Legacy + non-Artifact compatibility（M4-06-11）
- `storyCard / text / guidance / summary` 不因新 codec 被误删/转换；`storyCard → storyCard`（不转 `StoryArtifact`）；保存侧 `audioUrl` 清空保持；History loader 不因此 create `StoryWork`。

### 12. Architecture + full regression（M4-06-12）
- History codec 不得 import `libraryClient / storyArtifactPromotion / chatPromotionOrchestration I/O / generation transport / playback / React / Zustand store / server-Prisma / Settings store`；`initForUser` 恢复路径不得出现 `promotion.retry / executePromotionCreate / library.create / user.retry`；完整复跑 M4-06 targeted unit、M4-04 promotion、M4-05 UI、creation-chat、integration、catalog、tooling、lint、tsc、build、`git diff --check`。
