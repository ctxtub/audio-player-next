# 失效会话不再卡死加载门（Config Session-Invalid Gate）

> 范围：账号同步健壮性补丁。修复「会话指向已删除用户」时 `config.getMine` 抛 Prisma 外键错误（500）、且 `config.initForUser` 无兜底导致 `AccountSyncProvider` 加载门把整屏永久卡在「配置加载中…」的缺陷。属 [2026-06-21-account-sync-epoch-guard.md](2026-06-21-account-sync-epoch-guard.md) as-built 记的「遗留 3」。

## 背景与动机

`authedProcedure`（[lib/trpc/init.ts:43](../../lib/trpc/init.ts)）只校验 cookie 能解出 `ctx.session`，**不校验该用户在库中仍存在**。当 dev.db 被重置（旧用户行删除）但浏览器仍持旧会话 cookie 时：

1. `getOrCreateUserConfig`（[lib/server/userConfig.ts](../../lib/server/userConfig.ts)）对无 UserConfig 行的用户执行 `prisma.userConfig.create({ data: { userId, ... } })`，`userId` 指向已删除用户 → **外键约束冲突**（HTTP 500 / INTERNAL_SERVER_ERROR）。
2. `configStore.initForUser`（[stores/configStore.ts](../../stores/configStore.ts)）的异步体**无 `.catch`**，`fetchMyConfig` 拒绝时 `isLoaded` 永不置真。
3. `AccountSyncProvider`（[components/AccountSyncProvider/index.tsx:48](../../components/AccountSyncProvider/index.tsx)）的渲染门 `if (!authInitialized || !isConfigLoaded) return <PageLoading … />` 因此**永久阻塞整屏，无恢复路径**。

与账号同步正在收口的 401 / 会话失效健壮性同源。

## 目标

1. `config.getMine` 不再因「会话用户已删除」抛 500；改为明确的会话失效信号（`UNAUTHORIZED`）。
2. `config.initForUser` 无论因何失败，都不让加载门永久卡死。
3. 不回退正常路径：已登录有效用户、访客均与改前一致。

## 非目标（YAGNI）

- 不在 `authedProcedure` 全局加「用户存在性」校验（避免每个 authed 请求多一次查询、扩大影响面）；仅在会真正建行/撞外键的 `getOrCreateUserConfig` 处处理。
- 不实现「失效会话 → 自动登出并清会话 → 重定向登录」的完整闭环（更大的 auth 流改动）；本块仅保证加载门放行（回落访客），完整闭环留作后续。

## 方案对比

| 方案 | 描述 | 取舍 |
|---|---|---|
| **A 服务端校验用户存在 + 客户端访客兜底（采用）** | `getOrCreateUserConfig` 建行前 `findUnique` 用户，缺失抛 `UNAUTHORIZED`；`configStore.initForUser` 加 `.catch` 回落 `initialize()` 放行加载门 | ✅ 影响面最小（2 文件）；服务端语义正确（失效会话）；客户端绝不永久卡门。⚠️ 失效会话下 `isLogin` 仍为真但 config 走访客回落，属可接受边缘态（完整登出闭环后续做） |
| B 服务端对缺失用户返回默认配置（不持久化） | `create` 失败回落默认 DTO | ❌ 掩盖失效会话（已删除用户的会话仍“可用”），语义不正确 |
| C `authedProcedure` 全局校验用户存在 | 中间件每次查 User 表 | ❌ 每个 authed 请求多一次 DB 查询，影响面过大；本缺陷只需在建行处处理 |

## 设计

### 服务端：`getOrCreateUserConfig` 建行前校验用户存在

```ts
const existing = await prisma.userConfig.findUnique({ where: { userId } });
if (existing) {
  return toDto(existing);
}
// 行不存在才建行：先确认用户仍存在，避免「会话指向已删除用户」时 create 撞外键约束（500）。
// 此种会话已失效，统一抛 UNAUTHORIZED，由客户端按未登录/会话失效处理（而非整屏卡死）。
const userExists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
if (!userExists) {
  throw new TRPCError({ code: 'UNAUTHORIZED', message: 'SESSION_USER_NOT_FOUND' });
}
const created = await prisma.userConfig.create({ data: buildCreateData(userId, seed) });
return toDto(created);
```

`updateUserConfig` 的 `upsert` 同样可能撞外键，但其仅在已登录有效用户改配置时触发，不在首屏加载门路径上，故本块不动（失效会话不会走到改配置）。

### 客户端：`configStore.initForUser` 失败回落访客初始化

```ts
})()
  .catch(async (error) => {
    // 登录态配置拉取失败（如会话失效 UNAUTHORIZED / 网络错误）：
    // 回落访客初始化以放行加载门，避免首屏永久卡在「配置加载中…」。
    console.warn('[configStore] initForUser failed; 回落访客初始化放行加载门', error);
    if (epoch !== accountEpoch || get().isLoaded) {
      return;
    }
    await get().initialize();
  })
  .finally(() => {
    if (epoch === accountEpoch) {
      userInitPromise = null;
    }
  });
```

- 与 epoch 守卫一致：仅在未被 `reset` 打断（`epoch === accountEpoch`）且尚未加载时回落，避免覆盖已切换账号。
- `initialize()` 为既有访客初始化（拉系统音色 + 本地配置），成功即 `isLoaded:true`，加载门放行。

## 验收标准

1. 三道门全绿（lint / tsc / build）。
2. 失效会话（cookie 指向已删除用户）下首屏正常渲染，不再卡「配置加载中…」。
3. `config.getMine` 对失效会话返回 `UNAUTHORIZED`（401），不再 500。
4. 正常已登录用户与访客路径不回退。

## 验证结果（as-built · 2026-06-21）

- **三道门全绿**：`tsc --noEmit` 无错；`lint` 仅既有无关告警（`lib/agent/nodes/summary.ts`）；`build` 8 路由全过。
- **活体验证（dev 预览）**：复现了残留 `ClaudeA` 会话（dev.db 已重置、该用户行不存在）。改前首屏卡死「配置加载中…」；改后首屏正常渲染聊天页（主题卡片 + 输入框 + 发送按钮，`isConfigLoaded` 放行）。
- **顺带**：解卡后的登录会话被复用，对 epoch 守卫（项 4）与 chat 合并（项 3）做了确定性活体复现，均 PASS（见 epoch-guard 计划 as-built / 本会话记录）。
</content>
