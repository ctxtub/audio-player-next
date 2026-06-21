# 账号数据同步机制统一（Account Sync Unification）

> 范围：账号数据绑定大任务的**收口块**。四块上云数据（应用配置 / 提示词历史 / 生成历史 / 单会话聊天）已各自落地，本块把它们零散的「登录初始化 + 登出清理」约定抽象成一套**统一的账号数据同步机制**，建立单一事实源，并把登出清理与 `authStore` 生命周期解耦绑定，为将来 401/会话过期自动清理铺路。

## 背景与动机

`feat/account-config-sync` 分支已让登录用户的四块数据随账号云端同步。四块 store 共享一套近乎相同的「鸭子接口」：`syncEnabled` 标志 + `initForUser()`（幂等）+ `reset()`，差异仅在访客/本地侧。但**编排面是分散的**：

| 块 | 登录初始化 | 访客/本地初始化 | 本地持久化 |
|---|---|---|---|
| 应用配置 `configStore` | `initForUser()` | `initialize()` | localStorage ✓ |
| 提示词历史 `promptHistoryStore` | `initForUser()` | `hydrate()` | localStorage ✓ |
| 生成历史 `generationHistoryStore` | `initForUser()` | —（登录专属） | ✗ |
| 单会话聊天 `chatStore` | `initForUser()` | —（登录专属） | ✗（仅服务端） |

**现状的问题：**

1. **登录初始化散落两处** —— `ConfigInitializer`（全局）编排 config + generation + chat；`app/(main)/player/index.tsx`（页面本地）编排 promptHistory。不对称，promptHistory 已经「漏」在了 player 页。
2. **登出清理耦合在 UI 组件里** —— `UserSection.handleLogout` 手工列出 4 个 `reset()`。漏一个就是**跨账号数据泄漏**（高危正确性缺陷）。
3. **没有单一事实源** —— 「哪些 store 参与账号同步」这条知识散在 3 个文件，加第 5 块要改 2~3 处并逐一记得。
4. **登出清理只能从设置页手动触发** —— 当前无 401/会话过期的客户端拦截；若将来引入，清理逻辑无处复用。

## 目标

1. 建立**唯一事实源**：一个非 React 的账号同步注册表，集中列出参与的块及其 `initForUser / initForGuest? / reset` 生命周期钩子。
2. **登录初始化收归单点**：全局 Provider 统一分发四块初始化，消除 promptHistory 的页面本地不对称。
3. **登出清理绑定 `authStore` 生命周期**：清理键于 `isLogin` 的**下降沿**而非某个按钮的副作用；任何令 `isLogin` 置假的路径（手动登出、未来 401、会话过期）都自动触发清理，零额外接线。
4. **保持行为等价**：加载门时序、访客本地数据、「访客→登录客户端跳转」重拉服务端配置等既有行为不回退。

## 非目标（YAGNI / 越界）

- 不把各 store 内部的 init 实现抽进注册表（各块语义不同，如 config 的 seed 迁移）。注册表只统一**生命周期编排**，不统一实现。
- 不真的实现 401 拦截器；只把机制铺好，使将来「置 `isLogin=false` 即自动清理」成立。
- 不触碰其它三个遗留项（聊天 summary 持久化、播放器页生成替换会话、首次登录极窄竞态）。

## 方案对比

| 方案 | 描述 | 取舍 |
|---|---|---|
| **① 注册表 + authStore 订阅（采用）** | 注册表模块作 SSOT；同模块内 `useAuthStore.subscribe` 在 `isLogin` 下降沿自动 `resetAccountData()`；Provider 只管初始化分发 + 加载门；`authStore` 零改动 | ✅ 依赖最干净（authStore 保持纯粹）；reset 自动覆盖一切 auth 丢失路径（401-ready）；SSOT。⚠️ 订阅是模块副作用，需保证只装一次 |
| ② 注册表 + authStore.logout 直接调 | 由 `authStore.logout()` 成功后直接调 `resetAccountData()` | authStore 反向依赖数据 store；reset 只在显式 `logout()` 时触发，未来 401 须记得调，不满足「键于状态自动覆盖」 |
| ③ 每块 store 自订阅 | 各 store 自订阅 authStore、自管 init/reset | 4 份重复过渡检测；无 SSOT（违背统一目标）；无法集中做加载门。淘汰 |

**采用方案 ①。** 「绑定 authStore 生命周期」的最佳诠释不是让 authStore 广播（反向耦合），而是让 accountSync 模块**观察** authStore 状态——reset 成为「auth 丢失」的自然结果而非按钮副作用，未来 401 自动清理变成零额外接线。

## 设计概要

```
                 authStore（纯 auth 状态，零改动）
                  │  isLogin / initialized
        ┌─────────┴───────────┐
        │ 订阅(下降沿)         │ 读取
        ▼                     ▼
  accountSync.ts        AccountSyncProvider（原 ConfigInitializer）
  ── 唯一事实源 ──        ── 初始化分发 + 加载门 ──
  participants[]          · fetchProfile()
  initAccountForUser()    · 登录→initAccountForUser()
  initAccountForGuest()   · 访客→initAccountForGuest()
  resetAccountData()      · gate: !isConfigLoaded → PageLoading
  ensureAccountSyncSubscribed()
   └ isLogin 真→假 ⇒ resetAccountData
        │ 调度
        ▼
  [config] [promptHistory] [generationHistory] [chat]
```

**两条职责清晰分离：**

- **「拉数据进来」**（带渲染门）→ Provider 的 init 分发，键于 `isLogin` 上升沿与初始态。
- **「清数据出去」**（无需门）→ accountSync 订阅 `authStore`，键于 `isLogin` 下降沿。

### 注册表契约

```ts
interface AccountSyncParticipant {
  name: string;                                  // 调试标识
  initForUser: () => Promise<void>;              // 登录:拉服务端 + 开同步
  initForGuest?: () => Promise<void> | void;     // 访客本地初始化(登录专属块无)
  reset: () => void;                             // 登出/失效:清本地 + 关同步
}
```

注册表数组列出四块，各项以 `useXxxStore.getState()` 形式引用，模块非 React。

### 幂等归一（关键正确性细节）

`promptHistory/generation/chat` 的 `initForUser` 已内置 `if(syncEnabled) return` + `userInitPromise` 去重；**唯独 `configStore.initForUser` 没有**（现在靠 Provider 的 `!configSyncEnabled` 外部守卫）。收归注册表后须给 `configStore.initForUser` 补上同样的内部守卫（`syncEnabled` 短路 + `userInitPromise` 并发合流），让四块 `initForUser` 契约一致、可安全重复调用。

校验：补守卫后「访客→登录客户端跳转」重拉仍成立——访客态 `syncEnabled` 始终为 false，登录时守卫放行、照常重拉服务端配置（不回退上一次修复）。

### 登出时序

`isLogin` 真→假时：

1. authStore `set()` 同步触发订阅回调 → `resetAccountData()` 同步清四块（先清登录态数据）。
2. 若 Provider 仍挂载，其 init effect 随后跑访客初始化（config.initialize / promptHistory.hydrate）。

订阅是 app 生命周期的模块级订阅，不随 Provider 卸载而失效；故即便登出后导航到 `/auth`（Provider 卸载），清理仍已发生。

## 验收标准

1. **双账号防泄漏**：登录 A → 看到 A 的配置/历史/生成/聊天；登出；登录 B → 只见 B 的数据，无 A 残留。
2. **访客本地**：未登录态下 config + promptHistory 走本地；generation/chat 为空。
3. **访客→登录重拉**：客户端跳转登录后重新拉取服务端配置（既有行为不回退）。
4. **加载门**：`!isConfigLoaded` 仍显示 PageLoading，config 就绪后放行。
5. **单一事实源**：新增一块账号同步数据，只需在注册表数组加一行。
6. 三道门通过：`yarn lint`、`yarn tsc --noEmit`、`yarn build`。

## 与既有文档的关系

承接 `2026-06-20-account-config-sync.md` 确立的「登录态编排 / 登出清理 / 首次 seed 迁移」三件套，本块把前两件抽象为可复用的统一机制。后续若新增上云数据块，直接注册即可。
