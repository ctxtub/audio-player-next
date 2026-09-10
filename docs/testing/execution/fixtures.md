# 测试 Fixture 留存索引（Tracked 合成数据资产）

本文件是 `tests/fixtures/` 下 Git tracked 合成数据资产的唯一索引。
一切 fixture 均为**合成数据**（假 ID、假故事文本、假口令），真实数据与密钥绝不入库；
落盘库文件（`prisma/test-*.db`）命中 `.gitignore` 的 `*.db`，永不提交。

隔离库口径（SSOT）：单元测试写库必须走 `tests/fixtures/isolated-db.ts` 的
`setupIsolatedDb(<suite>)`——库路径 `prisma/test-<suite>.db`、先删残留再
`prisma migrate deploy`、动态导入 `lib/db` 单例； ambient `DATABASE_URL`
未设置时 `lib/db.ts` 回退到共享开发库 `prisma/dev.db`，**严禁依赖该回退**。

## Fixture 清单

| Fixture | 用途 | 构造方式 | 清理方式 | 是否写库 |
| --- | --- | --- | --- | --- |
| `tests/fixtures/isolated-db.ts`（`setupIsolatedDb` / `isolatedDbPath`） | 隔离 SQLite 库建连（唯一写库入口） | 删残留库文件 → `prisma migrate deploy` → 动态 `import lib/db` | 用例末按需删库文件；串行调度，禁并发写 | 是（仅隔离库） |
| `tests/fixtures/subjects.ts`（`makeGuestId` / `makeUsername` / `makeMessageId` / `makeGuestContext` / `makeUserContext` / `makeAnonymousContext`） | 访客/用户/匿名 caller 身份构造 | 纯内存合成（`g_<场景>_<时间戳>` 等假 ID + `127.0.0.1` 上下文） | 无（内存对象） | 否 |
| `tests/fixtures/story-seeds.ts`（`SQUIRREL_STORY_PARAGRAPHS` / `buildSquirrelStoryText` / `buildStoryChatMessage` / `buildParagraphProgressSeed`） | 段落断点恢复 4 段故事底本（与 `{{E2E_STORY_4P}}` 同构） | 源码内联合成中文故事；`contentHash` 由调用方对全文执行 `computeStoryContentHash` 得出，禁硬编码 | 随用例主体清理（访客行删/库文件删） | 经调用方写隔离库 |
| `tests/fixtures/ui-stubs.ts`（`installGlassToastStub` / `createToastCapture`） | GlassToast 模块打桩（store 侧 toast 断言） | `require.cache` 劫持，进程内有效；须在导入 store 前调用 | 进程退出即失效；`clear` 重置捕获器 | 否 |

## 范式用例

- `tests/test-paragraph-resume.ts` TC-P2-01（具名访客硬刷新段落断点恢复）消费
  `subjects` + `story-seeds`，TC-P2-16 消费 `ui-stubs` 捕获器：新增用例照此办理，
  优先复用既有 fixture，确需新种子时同步落盘本索引。
- R21 隔离库口径确认（2026-09-08）：`test-paragraph-resume` 历史上未设置
  `DATABASE_URL`，静态导入 `lib/db` 会隐式回退共享开发库 `prisma/dev.db`，
  且访客行（`g_resume_*`/`g_sleep_*`/`g_reg_*`/`g_mono_*`/`g_exp_gc_*` 等）从不清理；
  现已统一为 F1 口径——用例入口先调 `setupIsolatedDb('paragraph-resume')`
  （库文件 `prisma/test-paragraph-resume.db`，gitignored），再动态导入全部
  DB 依赖； ambient `DATABASE_URL` 不再决定写库去向。

## 新增 fixture 规则

1. 只收跨用例复用价值的构造（单一用例内联种子不必上浮）。
2. 合成数据禁出现真实账号、口令、密钥、生产 URL。
3. 写库型 fixture 必须经 `setupIsolatedDb`，并在本表登记清理方式。
