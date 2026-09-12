# Library URL 视图与搜索状态

功能域：07-故事库与作品资产

## 用户目标

故事库通过 URL 维护 view 与 canonical q 状态，支持 300ms debounce、IME 防抖与前进后退同步，不暴露内部游标或污染路由历史。

## 验收范围

本规范建立 M3-03 故事库 URL 视图（View）与搜索状态（Search State）契约：

1. **URL 参数白名单与游标安全隔离**：
   - URL 仅允许包含 `view` 与 `q` 两个查询参数；
   - 绝对禁止在 URL 中出现或序列化 `cursor`、`page`、`offset` 等任何服务端分页状态参数；
   - 基础路径 `/library` 等价于 `view=active&q=''`；默认视图 `active` 且无搜索词时不拼接额外参数；
   - 当 `view` 为 `favorites` 或 `trash` 时显式拼接 `view=...`；当有有效搜索词时显式拼接 `q=...`。

2. **视图合法性校验与兜底 (View Fallback)**：
   - 合法视图仅限于：`active`、`favorites`、`trash`；
   - 任何未提供、空值或非法视图参数（如 `view=foo`、`view=123`），严格自动兜底归一化为 `active`。

3. **搜索词规范化 (Canonical q)**：
   - 搜索词 `q` 的解析与序列化严格执行首尾空白过滤（trim）；
   - 输入框纯空白字符串（如 `"   "`）或清空操作，严格转为 `undefined`，并从 URL 中完全移除 `q` 参数；
   - 输入前后包含空格（如 `"  hero  "`）经过规整为 canonical `"hero"` 后存入 URL 与查询模型；
   - 中间空白保留（如 `"  a  b  "` -> `"a  b"`）。

4. **单向数据流与 300ms 防抖提交**：
   - 搜索数据流严格为：input draft -> 300ms debounce -> URL q (canonical) -> queryKey 变更 -> useInfiniteQuery 从 `cursor=undefined` 开始获取；
   - 绝对禁止输入即查、滞后写 URL 的不同源反模式；
   - 连续输入期间在 300ms 前零路由调用，满 300ms 后仅执行一次目标提交。

5. **IME 组合状态锁 (IME Composition Lock)**：
   - 触发 `compositionstart` 时，立即挂起/清除防抖定时器，在输入法选词组合期间进行零次路由调用与零次查询；
   - 触发 `compositionend` 时，以最终确认文本为准，从该时刻起重新启动完整的 300ms 倒计时，最终仅提交一次 canonical q。

6. **路由历史行为 (Push vs Replace)**：
   - 视图切换（`setView`）：使用 `router.push`，在浏览器历史栈中建立导航回退锚点；
   - 视图切换默认保留当前有效搜索词；
   - 搜索防抖提交（`setDraftQ` 防抖到期）：使用 `router.replace`，避免用户每次打字产生冗余历史记录污染；
   - 浏览器前进/后退（Popstate / Back / Forward）：自动同步输入框 `draftQ` 为 URL 中的当前 `q`，不产生任何额外的路由操作。

7. **架构静态守卫**：
   - 状态管理模块严格禁止导入底层 tRPC client、Prisma、server 内部代码或 `@trpc/react-query`。

## 关联实现与测试

- URL 筛选领域逻辑与控制器：`lib/client/libraryFilters.ts`
- React 状态 Hook：`app/(main)/library/useLibraryFilters.ts`
- URL 路由契约单元测试：`tests/unit/navigation/library-url-filters.unit.test.ts` (`exec-library-url-filters`)
- 搜索防抖与 IME 状态单元测试：`tests/unit/persistence-config/library-search-input.unit.test.ts` (`exec-library-search-input`)
