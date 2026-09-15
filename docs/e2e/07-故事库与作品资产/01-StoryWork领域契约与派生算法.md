# StoryWork 领域契约与派生算法

功能域：07-故事库与作品资产

## 用户目标

为故事库资产沉淀、多端列表浏览、播放历史溯源与音频投影提供稳定纯粹的领域契约。确保作品内容哈希指纹、展示标题与摘要派生、分页游标编解码及 DTO 输入输出结构在内存计算层面具备确定性与防御性。

## 范围与边界声明

本场景仅定义并约束纯内存域模型契约与算法实现（由 L1 单元测试直接断言），严格限定于领域计算层。
**显式排除以下后续能力**（属 M2-03～M2-09 里程碑，本用例不声称其覆盖）：
- 数据库持久化、事务与外键级联
- 用户/访客数据的所有权（ownership）隔离与多租户权限守卫
- tRPC Library 路由接入与数据库查询（list / get / create / remove 等）
- 数据库层全文搜索与 SQL LIKE 索引执行
- 创作入库幂等（`sourceMessageId` 冲突消解）
- 软删除与回收站生命周期流转
- 访客向注册用户的资产迁移与 30 天 GC 清理

## 契约验收标准

### 1. 内容指纹确定性与回归向量 (contentHash)
- 必须直接复用 `utils/segmentation.ts` 的 `computeStoryContentHash` 算法实现（12 位小写十六进制字符串），绝不引入第二套实现。
- 换行符跨平台等价：文本无论采用 CRLF 还是 LF 换行，归一化后计算所得指纹必须完全一致。
- 算法回归向量锁定：断言给定固定字符串（如 `"故事正文内容ABC"`）产出确定散列向量 `"dcd35acfdfde"`。
- 领域不变性保证：作品的标题（`title`）、收藏时间（`favoritedAt`）、删除时间（`deletedAt`）等元数据变动绝不会改变 `contentHash`。

### 2. 标题派生链 (title resolution)
- 按照明确的四级优先级流水线解析：
  1. **显式指定标题 (explicit proposedTitle / title)**：若提供有效非空标题则直接使用（实现保留 title 兼容入口）。
  2. **正文首行严格标题 (strict heading)**：只检查正文第一条非空行；支持 Markdown `#`～`######`、《标题》、【标题】三类严格标记；第一条非空行不匹配立即返回 null、不继续扫描后文。
  3. **提示词回退 (prompt fallback)**：最多 32 code points（超长结果为 31 + …）。
  4. **默认备选 (fallback literal)**：若以上均为空，统一回退为字面量 `"未命名故事"`。
- 标题超长截断与清洗：限制最大存储字符数，去除首尾空白。

### 3. 摘要生成与规范化 (excerpt derivation)
- 单行化空白压缩：将所有换行符（CRLF/LF）与多重空白压缩折叠为单个半角空格，并去除两端空格。
- 截取与省略边界：最多保留 160 个 Unicode 码点（code points）；当超出长度时截断并追加省略号 `…`。

### 4. 音频投影状态结构 (audio projection)
- 统一投影形态：默认缺省结构固定为 `{ status: 'missing', durationMs: null }`。
- 结构稳定性要求：DTO 中的 `audio` 字段为非可空（non-nullable）对象，为后续 M8 正式接入真实音频元数据时保留完全一致的外层数据形态。

### 5. DTO 边界分层契约
- **Summary DTO (`storyWorkSummaryDtoSchema`)**：专供故事库列表轻量级展示，仅包含基本元数据及 `audio` 投影对象，严禁包含 20,000 字符级别的完整正文 `storyText` 与 `prompt`。
- **Detail DTO (`storyWorkDetailDtoSchema`)**：包含完整正文 `storyText`、`prompt` 以及可选的 `sourceMessageId`。

### 6. 分页参数与列表输出契约
- **分页限制 (`libraryListInputSchema`)**：
  - `limit` 默认值为 20，合法取值范围为 `[1, 50]`；小于 1 或大于 50 的输入必须拒绝并抛出校验异常。
  - `view` 过滤视图默认为 `'active'`（支持 `'active' | 'favorites' | 'trash'`）。
- **列表输出 (`libraryListOutputSchema`)**：
  - 必须包含 `hasMore: boolean` 字段（必填，非 optional）。
  - 覆盖声明与恒等式契约：M2-02 L1 仅锁定字段必填（required）与规范样例；**M2-03 Read Service 必须从 nextCursor 派生 hasMore，并用 service regression 强制恒等式 `hasMore === (nextCursor !== null)`**（该恒等式继续作为最终 Library contract）。

### 7. 查询关键词规整 (query normalization)
- 去除首尾空白；空/缺省查询在 cursor fingerprint 层规范为 `''`；内部空白保持不变。

### 8. 不透明分页游标编解码 (opaque cursor)
- 游标使用 base64url 安全编码，对外隐藏内部持久化 ID。
- 游标结构化携带版本号、Keyset 组合键（`createdAt` 时间戳 + `id` 主键序号）。
- 上下文绑定安全性：游标编码时绑定当前视图类型（`view`）与搜索词（`query`）；若请求视图或关键词与游标签发时不一致，解析必须拒绝。
- 非法/损坏/版本不兼容游标必须返回解析失败（`null`），不得抛出未捕获异常。
- 保证严格确定的往返一致性（round-trip）。

## 关联实现与测试

- 契约常量：`lib/storyWork/constants.ts`
- 内容指纹：`lib/storyWork/contentIdentity.ts`
- 标题派生：`lib/storyWork/title.ts`
- 摘要截取：`lib/storyWork/excerpt.ts`
- 游标编解码：`lib/storyWork/cursor.ts`
- 元数据汇总：`lib/storyWork/metadata.ts`
- tRPC 模式：`lib/trpc/schemas/library.ts`
- 验证套件：`tests/unit/persistence-config/story-work-domain.unit.test.ts` (`exec-story-work-domain`)
