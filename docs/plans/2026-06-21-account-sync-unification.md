# 实施计划：账号数据同步机制统一

> 配套 spec：`docs/specs/2026-06-21-account-sync-unification.md`
>
> **Architecture:** 新建 `stores/accountSync.ts` 作为账号同步唯一事实源（参与块注册表 + `initAccountForUser/initAccountForGuest/resetAccountData` + `ensureAccountSyncSubscribed` 登出订阅）；`configStore.initForUser` 补幂等守卫使四块契约一致；`ConfigInitializer` → `AccountSyncProvider`，初始化分发收归单点；`UserSection` 与 `player` 页删除分散的 reset/init 接线。

## 变更文件一览

| 文件 | 动作 | 说明 |
|---|---|---|
| `stores/accountSync.ts` | 新建 | 注册表 SSOT + 三个编排函数 + 登出订阅 |
| `stores/configStore.ts` | 改 | `initForUser` 补 `syncEnabled` 短路 + `userInitPromise` 并发合流 |
| `components/AccountSyncProvider/index.tsx` | 新建（由 ConfigInitializer 改造重命名） | 初始化分发 + 加载门 + 装订阅 |
| `components/ConfigInitializer/` | 删除 | 被 AccountSyncProvider 取代 |
| `app/(main)/layout.tsx` | 改 | 更新 import 与组件名 |
| `app/(main)/player/index.tsx` | 改 | 删除 promptHistory 的本地 init effect |
| `app/(main)/setting/components/UserSection/index.tsx` | 改 | `handleLogout` 删 4 个 reset，删对应 import |

## Task 1：新建 `stores/accountSync.ts`

定义 `AccountSyncParticipant` 契约与 `participants` 注册表（config / promptHistory / generationHistory / chat，各以 `getState()` 引用）。导出：

- `initAccountForUser()` — 遍历 `participants`，逐块 `Promise.resolve(p.initForUser()).catch(warn)`，fire-and-forget。
- `initAccountForGuest()` — 仅对有 `initForGuest` 的块触发。
- `resetAccountData()` — 同步遍历 `p.reset()`。
- `ensureAccountSyncSubscribed()` — `subscribed` 守卫保证只装一次；`useAuthStore.subscribe((s, prev) => { if (prev.isLogin && !s.isLogin) resetAccountData(); })`。

**验证：** `yarn tsc --noEmit` 通过；模块不在顶层产生副作用（订阅仅在 `ensureAccountSyncSubscribed` 内）。

## Task 2：`configStore.initForUser` 幂等归一

在 `configStoreCreator` 内新增 `let userInitPromise: Promise<void> | null = null;`。改写 `initForUser`：

- 开头 `if (get().syncEnabled) return Promise.resolve();`
- `if (userInitPromise) return userInitPromise;`
- 主体（hydrate seed → 并行拉取 → set）包进 `userInitPromise = (async () => {...})().finally(() => { userInitPromise = null; })`，返回之。

保持原 set 逻辑不变（含 `syncEnabled: true`）。

**验证：** `yarn tsc --noEmit`；逻辑校验访客态 `syncEnabled=false` → 登录时不被短路，照常重拉。

## Task 3：`ConfigInitializer` → `AccountSyncProvider`

新建 `components/AccountSyncProvider/index.tsx`，三 effect collapse 成：

```tsx
useEffect(() => { fetchProfile(); }, [fetchProfile]);
useEffect(() => { ensureAccountSyncSubscribed(); }, []);
useEffect(() => {
  if (!authInitialized) return;
  if (isLogin) initAccountForUser();
  else initAccountForGuest();
}, [authInitialized, isLogin]);

if (!authInitialized || !isConfigLoaded) return <PageLoading message="配置加载中..." />;
return <>{children}</>;
```

订阅 selector 仅保留 `authInitialized`、`isLogin`、`fetchProfile`、`isConfigLoaded`。删除原对 config/generation/chat 各 init 的直接引用（改由 accountSync 调度）。删除旧 `components/ConfigInitializer/` 目录。

**验证：** `yarn tsc --noEmit`。

## Task 4：更新挂载点

`app/(main)/layout.tsx`：`import AccountSyncProvider from '@/components/AccountSyncProvider'`，JSX 标签同步改名。

**验证：** `yarn tsc --noEmit`。

## Task 5：消除 player 页与 UserSection 的分散接线

- `app/(main)/player/index.tsx`：删除 `initHistoryForUser` / `hydrateHistoryLocal` 的 selector 与那段 `useEffect`（promptHistory 已全局接管）；若 `authInitialized`/`isLogin` 仅此处用则一并清理无用 import。
- `UserSection/index.tsx`：`handleLogout` 内删 `resetConfig/resetPromptHistory/resetGenerationHistory/resetChatSession` 四个调用；删除对应 4 个 `useXxxStore(state => state.reset)` selector 与 import；从 `useCallback` 依赖数组移除。逻辑变为 `doLogout()` → toast → `router.push('/auth')`。

**验证：** `yarn tsc --noEmit`；确认无 unused import（`yarn lint`）。

## Task 6：全量验证

1. `yarn lint`
2. `yarn tsc --noEmit`
3. `yarn build`
4. preview 手测：
   - 双账号切换防泄漏（登录 A → 登出 → 登录 B，只见 B）
   - 访客本地（config + promptHistory 本地，gen/chat 空）
   - 访客→登录客户端跳转重拉服务端配置
   - 加载门正常（首屏 PageLoading → config 就绪放行）

## Task 7：提交

Conventional Commits：`refactor: 统一账号数据同步机制（注册表 SSOT + 登出订阅）`。落档 spec/plan 一并提交。
