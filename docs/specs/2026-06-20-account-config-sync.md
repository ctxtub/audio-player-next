# 账号体系对接（一）：应用配置同步 + 跨域基建约定

> 范围：账号数据绑定大任务的**第一块**。聚焦"设置页应用配置随账号云端同步"，并顺带确立后续三块（提示词历史、播放/生成历史、聊天会话）共用的跨域同步/隔离约定。
> 原则：服务端为权威源 + 乐观本地缓存；访客/未登录走纯本地；登出清理本地，杜绝账号间串号。

---

## 背景与目标

### 现状：账号体系"只认证、不接管数据"

认证链路已完整：`auth` router（注册/登录/登出/访客）、`session.ts`（cookie 编解码）、`middleware.ts`（路由守卫 + Cookie 续签）、`authStore`（前端登录态）。

但用户的"数据"完全没有跟账号绑定，存在两处"埋好了但没接线"的关键证据：

1. **`UserConfig` 表（`prisma/schema.prisma`）字段齐全但全项目无任何代码读写**——是死 schema。字段：`playDurationMinutes / voiceId / speed / floatingPlayerEnabled / themeMode / extras`。
2. **`authedProcedure`（`lib/trpc/init.ts:43`）已定义鉴权中间件但无任何 endpoint 使用**——没有一个"登录后才能调"的接口。

当前应用配置实际存储路径：
- `configStore`（`stores/configStore.ts`）→ localStorage `config-store`，**设备本地**。
- `configRouter.get`（`lib/trpc/routers/config.ts`）→ public、**硬编码** `playDuration=30 / floatingPlayerEnabled=true`，不读用户 DB。
- 主题 `themeMode` → 由独立的 `ThemeProvider` 管理（本地）。

后果：换设备配置丢失；**同设备换账号会串数据**；登录对配置毫无意义。

### 目标

1. 登录用户的应用配置（时长 / 音色 / 语速 / 浮窗 / **主题**）随账号云端同步，跨设备一致。
2. 首次激活 `authedProcedure` + 首次读写 `UserConfig` 表。
3. 确立一套可被后续三块复用的**跨域基建约定**：登录态编排、登出清理、首次绑定数据迁移。

---

## 关键决策（已与需求方确认）

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 同步模型 | **服务端为准 + 乐观本地缓存** | 登录后以 `UserConfig` 为唯一权威源；本地仅作离线缓存/降级。访客/未登录走纯本地。 |
| 首次绑定迁移 | **行不存在时用本地 seed 初始化** | `UserConfig` 行尚未创建（首次）时用本地配置 seed 首行；之后服务端为准、忽略 seed。保留访客/老用户已调好的设置，且只在建行那一刻生效，逻辑简单。 |
| 登出/切换清理 | **登出重置为默认 + 清 localStorage** | 彻底杜绝账号间串号；与 seed 迁移不冲突（seed 只能拿到真正匿名/访客态的本地值）。 |
| 主题 themeMode | **纳入本次同步** | themeMode 本就是 `UserConfig` 字段，纳入后主题随账号跨设备一致。 |
| 保存时机 | **乐观更新 + 防抖 ~500ms 回写** | 滑块/开关高频变更避免请求风暴；UI 即时响应。 |
| 写冲突 | **upsert，last-write-wins** | 配置项简单、单用户多设备并发写罕见，可接受。 |

### 被否决的备选
- *本地优先 + 后台合并*：离线体验更好，但登录时的本地↔服务端合并/冲突逻辑复杂，YAGNI。
- *仅服务端、不留本地*：最简单，但每次进页/恢复有网络延迟、离线不可用。
- *按 userId 分档缓存 localStorage*：多账号离线体验好，但实现复杂且设备上残留多账号数据，本期不做。

---

## 架构与数据流

```
未登录 / 访客
  └─ configStore 纯本地（localStorage `config-store`，维持现状）

登录用户
  登录 / 进入应用
    └─ config.getMine(seed = 当前本地配置)         [authedProcedure]
         服务端：UserConfig where userId
           ├─ 行不存在 → 用 seed（经校验）建首行，返回 DTO
           └─ 行存在   → 直接返回 DTO（忽略 seed）
         └─ configStore 用 DTO 覆盖状态 + 写 localStorage（离线缓存）
         └─ themeMode 同步给 ThemeProvider

  设置页改动（时长/音色/语速/浮窗/主题）
    └─ 乐观更新本地 UI + localStorage
         └─ 防抖 ~500ms → config.updateMine(patch)  [authedProcedure]
              ├─ 成功 → 用返回 DTO 校正本地
              └─ 失败 → 保留本地乐观值 + GlassToast 提示 + 标记 dirty，下次进页重试

登出 / 切换账号
    └─ authStore.logout 成功 → configStore.reset()：回默认 + 清 localStorage
       （ThemeProvider 同步回默认）
```

### 跨域基建约定（本块确立，后续三块复用）

1. **登录态编排集中化**：新增客户端编排单元（`ConfigBootstrap` 组件或 hook），等 `authStore` 就绪后按 `isLogin` 决定走本地 init 还是 `initForUser(seed)`。**不在 store 内部隐式 `getState()` 跨 store 耦合**。
2. **登出清理钩子**：`authStore.logout` 成功后触发受影响 store 的 `reset()`。后续每个上云的 store 都挂这个清理点。
3. **首次绑定迁移范式**：protected `getMine` 接口接收可选 `seed`，仅当 DB 行不存在时消费，建行后即权威。

---

## 数据模型层

`UserConfig` 表字段已足够，**本块不改 schema**。

字段映射（DB ↔ 前端 `APIConfig`）需要一个映射层：

| DB（UserConfig） | 前端（APIConfig / Theme） | 备注 |
|------------------|---------------------------|------|
| `playDurationMinutes` | `playDuration` | 命名差异，需映射 |
| `voiceId` | `voiceId` | 空串=系统默认 |
| `speed` | `speed` | |
| `floatingPlayerEnabled` | `floatingPlayerEnabled` | |
| `themeMode` | ThemeProvider `themeMode` | `dark`/`light`/`system` |
| `extras` | —（预留，本块不用） | |

---

## 接口设计（tRPC）

新增 `lib/trpc/schemas/config.ts`：
- `configSeedSchema`：建行迁移用，全字段可选，带 DB 对齐约束（playDuration 10–120、speed 0.25–4.0、themeMode 枚举…）。
- `configPatchSchema`：更新用，部分字段。
- `userConfigDtoSchema` / `UserConfigDTO` 类型：返回 DTO 形状（前端语义命名）。

`lib/trpc/routers/config.ts` 改造：

| Procedure | 类型 | 说明 |
|-----------|------|------|
| `getMine` | `authedProcedure.input({ seed? }).query` | 查当前用户 `UserConfig`；不存在则用 seed 建行；返回 DTO。 |
| `updateMine` | `authedProcedure.input(patch).mutation` | upsert 当前用户配置，返回最新 DTO。 |
| `get`（现有） | `publicProcedure`，**重定位** | 只返回"系统级"数据：`voicesList` + 系统默认 `voiceId`（来自 env）。剥离 playDuration/floatingPlayer 这类用户偏好默认（交给 `UserConfig` 的 Prisma `@default`）。 |

新增 `lib/server/userConfig.ts`：把 prisma 的 upsert / seed 建行 / DB↔DTO 映射逻辑从 router 抽出，保持 router 瘦身、可独立测试。

---

## 状态管理层（configStore 改造）

新增/调整 actions：
- `initForUser(seed)`：登录后调用，`config.getMine(seed)` → set 状态 + 写 localStorage 缓存。
- `update(partial)`：保持乐观本地更新 + localStorage；**登录态下**追加防抖 `updateMine` 回写（失败保留乐观值 + dirty 标记）。
- `reset()`：登出调用，回默认态 + 清 localStorage。
- 现有 `initialize`（本地 + `config.get`）保留给未登录/访客路径，并按 `get` 重定位后的语义调整（仅取 voicesList + 系统默认）。

themeMode 接入：`ConfigBootstrap` 在 `initForUser` 拿到 DTO 后把 themeMode 同步给 `ThemeProvider`；设置页主题改动经 `update` 走同一回写链路；`reset()` 时主题回默认。

---

## 边界场景

- **离线 / 保存失败**：乐观本地值保留，`GlassToast` 提示，标记 dirty，下次进页重试。getMine 失败 → 降级用 localStorage 缓存。
- **访客**：不调任何 protected 接口，纯本地；UI 维持"访客模式·数据不会保存"提示。
- **seed 防覆盖**：服务端仅在行不存在时消费 seed，存在即忽略——杜绝用本地覆盖云端造成串号。
- **并发写**：upsert last-write-wins。

---

## 验收标准

1. 登录用户在 A 设备改时长/音色/语速/浮窗/主题，B 设备登录同账号后配置一致。
2. 同设备：用户 A 登录配置 X → 登出 → 用户 B（新账号）登录，看到的是 B 的默认/自有配置，**不残留 A 的配置**。
3. 访客调好设置后注册 → 设置被迁移到新账号（首行 seed 生效）。
4. 老用户（升级前有本地配置）首次登录 → 本地配置被 seed 上云，不丢失。
5. 未登录/访客全程不触发 protected 接口，纯本地可用。
6. 设置页连续拖动滑块只触发防抖后的少量 `updateMine` 请求，UI 即时响应。
7. `yarn lint`、`yarn tsc --noEmit`、`yarn build` 全通过。

---

## 影响范围 / 预估文件清单

| 文件 | 改动 |
|------|------|
| `lib/trpc/schemas/config.ts` | 新增：seed/patch/DTO schema |
| `lib/trpc/routers/config.ts` | 加 `getMine`/`updateMine`，重定位 `get` |
| `lib/server/userConfig.ts` | 新增：DB↔DTO 映射 + upsert/seed 服务 |
| `stores/configStore.ts` | 加 `initForUser`/`reset` + 防抖回写 + 映射 |
| `stores/authStore.ts` | login/register/logout 钩入 config 编排（或经编排层） |
| `ConfigBootstrap`（新，组件或 hook） | 按登录态编排 init + 登出清理 + theme 同步 |
| `components/ThemeProvider`（视实现） | 初值取自 UserConfig、改动经统一回写 |
| `app/(main)/setting/*` | 主题改动接入云端回写链路（其余 update 调用基本不变） |

`prisma/schema.prisma`：本块**不改**。

---

## 与后续三块的关系

本块确立的"登录态编排 / 登出清理 / 首次 seed 迁移"三件套，后续提示词历史、播放历史、聊天会话上云直接复用同一范式，各自再开独立 spec → plan。
