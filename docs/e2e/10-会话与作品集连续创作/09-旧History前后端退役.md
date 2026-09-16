# 旧 History 前后端退役

功能域：10-会话与作品集连续创作

## 用户目标

产品中不再存在 Prompt History / Generation History 的入口、面板、数据与本地缓存；用户看到的是围绕作品集的创作页，而不是旧历史列表。

## 范围与边界声明

本场景覆盖 T2 的 History 前后端退役（L1 静态守卫 + L3 视觉/路由断言）。
**明确排除**：旧表物理删除（contract migration，属 T4 且需另行授权）；`docs/archive/**` 与 migration 历史 allowlist。

## 契约验收标准

### 1. 前端无入口（no UI entry）
- 创作页不存在「历史」按钮、History 面板、提示词/生成历史 tab。
- 不存在 `HistoryPanel` / `HistoryRecords` / `GenerationHistory` / `HistoryList` 组件实现。

### 2. 客户端无实现（no client surface）
- 不存在 `promptHistoryStore` / `generationHistoryStore`。
- 不存在 `lib/client/promptHistory.ts` / `lib/client/generationHistory.ts`。
- `chatStore` 不存在 `pendingAutoSend` 自动发送桥；无 History 本地缓存 key。

### 3. 后端无路由/服务（no server surface）
- tRPC router 不注册 `promptHistory` / `generationHistory`；不存在对应 router/schema/server service 文件。
- 旧新写路径停止：不再对 legacy History 表写入。

### 4. 回退语义（rollback）
- 回退只关闭新 orchestrator 与集合读路径（`STORY_COLLECTION_READS_ENABLED`），**不恢复 History**。
- 旧表数据保留，直到 contract migration 另行授权。

### 5. 其他表面清理
- `accountSync` / `guestGc` / `unifiedMigration` / `chatFlow` 不再引用 History 模块。
- 静态守卫禁止在终局产品代码中出现上述标识符（migration 与 archived docs 可 allowlist）。

## 关联实现与测试

- 静态守卫：`tests/unit/creation-chat/legacy-history-retirement.unit.test.ts` (`legacy-history-retirement`)
- L3：`tests/system/browser/scenarios/history-retired.spec.ts` (`exec-l3-history-retired`)
