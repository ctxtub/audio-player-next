# 账号同步 init/reset 竞态守卫（Account Sync Epoch Guard）

> 范围：账号数据绑定大任务的**收尾修复块**。统一同步机制（注册表 SSOT + 登出订阅，见 [2026-06-21-account-sync-unification.md](2026-06-21-account-sync-unification.md)）落地后，遗留两个围绕 `initForUser` 异步窗口的竞态：**项 4**（在途 init 被 reset 打断后仍回写旧账号数据）与**项 3**（首次登录 init 完成前发的消息被整体 replace 冲掉）。本块用「每-store 账号代次（epoch）守卫 + chat 终态合并」一并修复。

## 背景与动机

四块账号同步 store（config / promptHistory / generationHistory / chat）共享同一套 `initForUser` 惯用法：闭包去重 `userInitPromise` + 异步拉取后整体 `set({ ...data, syncEnabled: true })`。该惯用法在「拉取 await 窗口内状态又发生变化」时不安全，暴露两个竞态。

### 项 4 —— 在途 init 被 reset 打断后回写旧账号数据（正确性缺陷）

`reset()` 仅做 `set({ ...空, syncEnabled: false })`，**不取消在途 Promise**。以 generationHistory 为例（[stores/generationHistoryStore.ts:58](../../stores/generationHistoryStore.ts)）：

```ts
userInitPromise = (async () => {
  const records = await fetchMyGenerations();   // ← await 期间若 reset() 跑了
  set({ records, syncEnabled: true });          // ← 仍落上一账号数据 + 重新打开同步
})();
```

登出 / 401 发生在拉取途中时，在途请求 resolve 后会把**上一账号的数据重新写回、并把 `syncEnabled` 重新置 `true`**。这是跨账号数据可见 / 可回写的正确性缺陷，401 / 会话过期场景更易触发，四块同形（config 的 `initForUser` 终态 set 同样无守卫，5f77ba9 清 `userInitPromise` 解决的是另一个问题——重新初始化返回旧 resolved promise 导致加载门卡死——并不能取消已在跑的 async 体）。

### 项 3 —— 首次登录 init 整体 replace 冲掉刚发的消息

chat 发消息走 `dispatch({ type: 'user.submit' })` **无条件** `set` 追加到 `messages`（[stores/chatStore.ts:193](../../stores/chatStore.ts)），而 `initForUser` 的终态是整体 `set({ messages: 服务端快照 })`（[stores/chatStore.ts:518](../../stores/chatStore.ts)）。首次登录 init 的 await 窗口内若用户发了消息，终态的整体 replace 会把这条本地消息冲掉。

### 相邻隐患 —— reset 未清 `userInitPromise`

`configStore.reset()` 已清 `userInitPromise`（5f77ba9），但 chat / promptHistory / generationHistory 的 `reset()` **没清**。这导致「登出 →（在途窗口内）→ 登录」时序下，新登录的 `initForUser` 走 `if (userInitPromise) return userInitPromise` 拿到旧账号（必然 bail）的 promise，新账号数据永不加载。此隐患是 epoch 守卫正确性的前提，须一并校正。

## 目标

1. 修复**项 4**：在途 `initForUser` 被 `reset()` 打断后不再回写旧账号数据、不再重新打开 `syncEnabled`，四块一致。
2. 修复**项 3**：首次登录 init 完成时，保留 await 窗口内新发的本地消息，同时正常恢复服务端历史。
3. 校正相邻隐患：四块 `reset()` 一致清 `userInitPromise`，使「重新登录起新请求」成立。
4. **保持行为等价**：登录以账号历史 / 服务端配置为准的既有单会话语义不回退；加载门时序不回退。

## 非目标（YAGNI / 越界）

- 不引入测试框架（仓库现仅 lint/tsc/build 三道门）。
- 不取消在途网络请求（AbortController 方案，见下「方案对比」C），仅作废其回写。
- 不触碰其它两个遗留项（聊天 summary 持久化、播放器页生成替换会话）。
- 不给 config / prompt / generation 做「本地写入合并」：这三块本地写入受 `syncEnabled` 门控（init 期间为 `false`），不存在 chat 那种无条件追加；且对它们「登录以服务端为准」是**正确语义而非 bug**（见「设计 · 边界决策」）。

## 方案对比

| 方案 | 描述 | 取舍 |
|---|---|---|
| **A 每-store 本地 epoch 闭包 + chat 终态合并（采用）** | 每个 store creator 内加闭包计数器 `accountEpoch`，`reset()` 自增；`initForUser` 进入时捕获、终态 `set` 前校验；chat 额外把窗口内本地新增消息并回 | ✅ 改动最小、四块同形、与既有 `userInitPromise` 闭包惯用法同构；零跨 store 耦合，各块自洽可独立审读。⚠️ 两套机制（epoch 放弃 + chat 合并），但职责清晰、可组合（epoch 先挡账号切换，再做同账号合并） |
| B accountSync 共享账号 epoch | 单一 epoch 放 accountSync，账号转换处递增，各 store 读取校验 | ❌ accountSync 已 import 各 store，store 再 import accountSync 形成**循环依赖**；各 store 的 reset 还被 authStore 下降沿单独触发，递增点散布多处，耦合与接线更重 |
| C AbortController 取消在途请求 | `reset()` abort 在途 fetch，init 在 set 前查 `signal.aborted` | ❌ 盖不住项 3（本地发消息不是 abort）；需把 signal 透传进 tRPC/axios 封装，侵入更大；两个竞态无法统一 |

## 设计

### 机制：每-store 账号代次（epoch）

每个 store creator 内新增闭包 `let accountEpoch = 0`。`reset()` 自增并清 `userInitPromise`；`initForUser` 进入时捕获代次，终态 `set` 前与 finally 清理均以代次校验「我是否仍是当前代次」：

```ts
let accountEpoch = 0;            // 账号代次：reset 自增，作废在途 init 的回写
let userInitPromise: Promise<void> | null = null;

initForUser: () => {
  if (get().syncEnabled) return Promise.resolve();
  if (userInitPromise) return userInitPromise;
  const epoch = accountEpoch;                       // ① 捕获进入代次
  userInitPromise = (async () => {
    const data = await fetchX();
    if (epoch !== accountEpoch) return;             // ② 期间 reset 过 → 放弃回写
    set({ ...data, syncEnabled: true });
  })()
    .catch((e) => console.warn(...))
    .finally(() => {
      if (epoch === accountEpoch) userInitPromise = null;   // ③ 仅本代次才清句柄
    });
  return userInitPromise;
},

reset: () => {
  accountEpoch++;                 // 作废在途回写
  userInitPromise = null;         // 让重新登录能起新请求
  /* …既有 state 清理保持不变… */
},
```

- **② 是项 4 的核心修复**：reset 自增代次后，旧 promise 的 `epoch !== accountEpoch`，整体跳过回写——既不落旧数据，也不重开 `syncEnabled`。
- **③ epoch 守卫 finally 的必要性**：`登出 →（窗口内）→ 登录` 时序下，旧 promise resolve 时若无条件 `userInitPromise = null`，会清掉新登录刚起的 promise。代次守卫保证旧代次不动新代次的句柄。
- **reset 清 `userInitPromise` 的必要性**：否则新登录的去重判断 `if (userInitPromise) return` 拿到旧账号 promise，新账号永不加载。

### chat 终态合并（项 3）

chat 的终态由整体 replace 改为「服务端历史在前 + 窗口内本地新增续后」。进入时以已有消息 id 作 baseline，终态把非 baseline 的本地消息并回：

```ts
const epoch = accountEpoch;
const baselineIds = new Set(get().messages.map((m) => m.id));   // 进入时已有（访客/旧态）
const dtos = await fetchMyConversation();
if (epoch !== accountEpoch) return;                              // 账号已切 → 放弃（项 4）
const serverMessages = dtos.map(/* DTO → ChatMessage */);
const appendedLocally = get().messages.filter((m) => !baselineIds.has(m.id));  // 窗口内本地新增
set({ messages: mergeConversation(serverMessages, appendedLocally), syncEnabled: true });
```

`mergeConversation(server, local)` 抽成**纯函数**（贴近 chatStore，或 `stores/` 内同领域工具），语义：服务端历史在前，本地新增按 `id` 去重续后。示例：

| 输入 server | 输入 local | 输出 |
|---|---|---|
| `[a, b]` | `[]` | `[a, b]`（无窗口写入，等价旧行为） |
| `[a, b]` | `[c]` | `[a, b, c]`（保住窗口内发的 c） |
| `[a, b]` | `[b, c]` | `[a, b, c]`（b 与 server 重复，按 id 去重） |
| `[]` | `[c]` | `[c]`（首登从空态，c 续于空历史后） |

**语义后果**：登录仍**丢弃访客旧会话**（baseline 内 → 不并），维持现有单会话「登录以账号历史为准」语义；**只额外保住窗口内刚发的消息**。

### 边界决策（与用户确认）

- **仅 chat 做合并**：config / prompt / generation 的本地写入受 `syncEnabled` 门控（init 期间为 `false`），不存在 chat 那种无条件追加。对这三块「登录以服务端为准」是正确语义——例如 config 在 init 窗口内被改，被服务端账号配置覆盖属**预期行为**，故不合并。
- **`initialize()`（config 访客路径）不在范围**：epoch 只守卫账号路径 `initForUser`。访客初始化的代次安全不属本块目标。

### 错误处理与边界

- fetch 失败：维持既有 `.catch` 告警；`syncEnabled` 保持 `false`；`userInitPromise` 经 ③ 清空。
- `accountEpoch` 为单调自增整数，会话内无溢出顾虑。
- chat 既有「`set` 不触发 scheduleSave，避免把恢复结果回写」的注释语义保持：合并后的终态 set 仍是直接 set，不经 scheduleSave。

## 验收标准

1. 三道门全绿：`yarn lint`、`yarn tsc --noEmit`、`yarn build`。
2. **项 4 手测**：在某块 `initForUser` 的 `await` 后临时注入 `await sleep(2000)`，期间触发登出 / 401 → 确认旧账号数据不回写、`syncEnabled` 不被重新置 `true`。
3. **项 3 手测**：在 chat `initForUser` 注入延迟，期间发一条消息 → 确认服务端历史正常恢复且刚发的消息保留在末尾。
4. **回归**：正常登录（无打断）四块数据照常加载；访客本地数据、登录跳转重拉配置等既有行为不回退。
5. `mergeConversation` 纯函数符合上表 4 个输入/输出示例。

## 影响面

- `stores/configStore.ts`、`stores/promptHistoryStore.ts`、`stores/generationHistoryStore.ts`、`stores/chatStore.ts`：各加 `accountEpoch` 闭包、`initForUser` 守卫、`reset` 校正。
- chat 新增 `mergeConversation` 纯函数。
- 无接口 / 数据模型 / UI 改动；无新依赖。
</invoke>
