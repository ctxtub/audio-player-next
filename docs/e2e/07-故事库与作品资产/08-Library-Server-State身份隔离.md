# Library Server State 与身份隔离

功能域：07-故事库与作品资产

## 用户目标

建立服务端状态（Server State / React Query）基础设施，在用户登录、登出、访客模式切换与快速切号时，严格实现 QueryClient 缓存清空与在途请求取消，确保不同身份间的数据绝对隔离，防止任何旧身份数据被延迟响应复活或交叉污染。

## 验收范围

本规范建立 M3-01 Server State 基础设施与身份隔离契约：
1. **ServerStateProvider 架构挂载**：
   - `ServerStateProvider`（亦名 `MainQueryProvider`）挂载于 `AccountSyncProvider` 内部、主 UI（`ThemeConfigBridge`、页面、全局 UI）外部；
   - 首次 mount 时身份已解析完毕（由 `AccountSyncProvider` 保证 `auth.initialized` 与 `config.isLoaded` 首屏门）；后续生命周期仅需响应身份跃迁（Identity Transition）。
2. **纯净身份指纹判定 (Identity Fingerprint)**：
   - 身份指纹严格且仅由四元组组成：`initialized`、`isLogin`、`isGuest`、`username`；
   - 严禁将 `nickname`、`loading` 或 `error` 等展示态/过程态字段作为身份信号，昵称修改或加载态切换绝对不触发缓存清空。
3. **无公开 ID 时的整库清空 (Full QueryClient Purge)**：
   - 因具名访客模式在前端无公开 `guestId`，前端不将身份 ID 混入 query key；
   - 任何身份跃迁（Guest → User、User → Guest、User A → User B、Visitor → Guest）均直接执行整个 QueryClient 的安全清理。
4. **必须采用 Cancel + Clear 语义（严禁 Invalidate 替代）**：
   - 身份清理必须采用 `queryClient.cancelQueries() + queryClient.clear()`；
   - 严禁使用 `invalidateQueries` 替代身份清理（`invalidate` 会保留 stale 缓存，导致旧身份数据在短时间内可被同步读取，破坏安全隔离）。
5. **单次跃迁单次清理 (Single Transition → Single Purge)**：
   - 每次身份跃迁（Identity Transition）生命周期内必须且只能触发一次 purge（`cancelQueries() + clear()`）；
   - 严格杜绝在后续 React render 周期或子组件 effect 中发生二次或多余清理，确保新身份挂载后发起的有效在途请求与新缓存不被误杀。
6. **在途请求取消与防复活竞态安全 (In-Flight Cancellation & Anti-Resurrection Race Safety)**：
   - 典型竞态场景：Guest 发起 query A（deferred promise，尚未返回）→ 触发身份切换至 User → 执行 `cancelQueries() + clear()` → User 发起同 queryKey 的 query B 并成功 resolve → query A 最终延迟 resolve；
   - 最终缓存必须仅包含 User query B 的数据，query A 晚返回绝不得复活或污染当前缓存。
7. **不读取 Library 数据**：
   - M3-01 阶段只建立基础设施，不引入任何 Library 数据读取与组件消费。

## 关联实现与测试

- Provider 组件：`components/ServerStateProvider/index.tsx`
- QueryClient 基础设施：`lib/client/queryClient.ts`
- 布局集成：`app/(main)/layout.tsx`
- 验证套件：`tests/integration/persistence-config/server-state-identity-isolation.integration.test.ts` (`exec-server-state-identity-isolation`)
