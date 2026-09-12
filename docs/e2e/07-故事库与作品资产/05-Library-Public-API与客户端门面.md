# Library Public API 与客户端门面

功能域：07-故事库与作品资产

## 用户目标

当前用户与具名访客通过稳定、鉴权、隔离且不泄漏底层实现细节的 Library Public API 完成作品查询与生命周期操作，前端仅通过冻结的 Client Facade 消费该契约。

## 验收范围

本规范冻结 M2-06 公开 API 与客户端门面契约：
1. **8 个 Canonical Procedure**：`list`、`get`、`create`、`rename`、`setFavorite`、`moveToTrash`、`restore`、`deletePermanently`，严禁暴露未冻结旁路。
2. **守卫与主体解析**：全量 Procedure 统一挂载 `guardedProcedure` 与 `resolveSubject`，物理隔绝跨租户访问。
3. **匿名访问拦截**：匿名请求（无 Session 且无有效 Guest Cookie）调用任意 Procedure 均统一拒绝并返回 `UNAUTHORIZED` (401)。
4. **User 与 Guest 成功路径**：已登录用户与具名访客均可顺利执行全量 8 个操作，严格返回 DTO 结构（含 missing 音频投影），严禁直接透传 Prisma 内部模型。
5. **错误码契约透出**：合法领域错误与校验异常明确透出为 `BAD_REQUEST`、`NOT_FOUND`、`CONFLICT`。
6. **底层错误安全脱敏**：任何 Prisma 报错（如 P2002、P2025、字段名、表名）及未知底层异常统一拦截并转化为 `INTERNAL_SERVER_ERROR`，绝不向上泄漏数据库内部细节。
7. **写操作速率限制 (Write Rate-Limit)**：所有 6 个变更类 Procedure（`create`、`rename`、`setFavorite`、`moveToTrash`、`restore`、`deletePermanently`）挂载基于有界内存滑动窗口的请求频次限制，超限确定性返回 `TOO_MANY_REQUESTS` (429)。
8. **Client Facade 委托消费**：前端仅通过类型安全的客户端门面（`lib/client/library.ts` 及 `libraryClient`）消费上述 8 个 Procedure，入参收窄为结构体，消灭悬空重载。
9. **测试接缝隔离**：服务内部并发测试接缝（`__testBeforeMutationHook`）严禁向 tRPC input schema、client facade 或 public library contract 泄漏。

## 关联实现与测试

- tRPC Router：`lib/trpc/routers/library.ts`
- Client Facade：`lib/client/library.ts`、`lib/client/internal/libraryFacadeFactory.ts`
- 数据契约：`lib/trpc/schemas/library.ts`
- 验证套件：`tests/integration/persistence-config/story-work-router-facade.integration.test.ts` (`exec-story-work-router-facade`)
