# 故事库层级与单篇作品精简规范

- **Date**: 2026-10-15
- **Status**: VERIFIED
- **Trigger**: 解决故事库按钮过多、操作倒错、单篇收藏与回收站割裂、卡片交互不聚焦以及合集详情页功能笨重的问题。

## 1. 业务与契约变更范围

### 1.1 单篇故事（StoryWork）生命周期与收藏策略变更
- **取消单条故事收藏**：
  - 核心心智统合至“故事集（StoryCollection）”，单篇故事不再提供收藏状态与操作入口；
  - 前端 UI（详情页、单篇操作项）彻底移除单篇收藏相关星标与按钮；
  - 后端 API：单篇收藏逻辑收敛，不再暴露或维护单篇收藏状态。
- **单篇故事删除不进回收站（物理直接删除）**：
  - 单篇故事删除直接执行物理删除与音频资源 Tombstone 关联清理，不打 `deletedAt` 进入回收站；
  - 回收站仅服务于故事集（StoryCollection）整体的还原与销毁；
  - 详情页单篇列表项删除操作文案为“删除”，居中弹窗确认后立即物理删除。

### 1.2 前后端契约规范化与一致性
- **底层契约统一**：
  - `lib/trpc/schemas/library.ts` 导出标准化 `libraryDeleteWorkInputSchema` 与 `LibraryDeleteWorkInput`；
  - `lib/server/storyWork.ts` 导出 `deleteStoryWorkForSubject`，统一调用 `executeStoryWorkPhysicalDelete`（含音频 tombstone 清理，不打 `deletedAt`）；
  - `lib/trpc/routers/library.ts` 声明 `deleteWork` mutation，对齐频控与鉴权，保留 `moveToTrash` 作为兼容别名；
  - `lib/client/libraryMutations.ts` 及门面层（`libraryFacadeFactory.ts` / `library.ts`）统一暴露 `deleteWork`，负责清理播放器活动项、移除曲目缓存与更新合集详情。

### 1.3 故事库主页（/library）与卡片（CollectionCard）
- **卡片热区与行动点收敛**：
  - 卡片整体为可点击热区，点击卡片主体进入故事集详情页；
  - 移除卡片上冗余的 `<details> 管理故事集` 及其内嵌删除按钮；
  - 卡片上仅保留两个明确交互按钮：
    1. **收藏按钮**（右上角星标，点击即时切换收藏，阻止冒泡）；
    2. **播放按钮**（显式文案“从头开始”，以 restart 模式启动合集播放，阻止冒泡）。
  - 不再透出“继续播放”与任何卡片级管理按钮。
- **移除故事库单篇筛选**：
  - 由于单篇故事不再支持收藏且删除不进回收站，故事库收藏与回收站 Tab 下彻底移除“故事集 / 单篇故事”二级筛选胶囊；
  - 故事库全视图（全部、收藏、回收站）统一呈现故事集。

### 1.4 故事集详情页轻量化（曲目单 Tracklist 模式）
- **Hero 头部纯粹化**：
  - 聚焦音频消费：合集大标题、篇数统计、主 CTA（继续播放）与次 CTA（从头播放）；
  - 右上角省略号管理菜单，收纳合集重命名与删除故事集（废弃原有的 `<details>` 内嵌表单）；
- **单篇列表重构为紧凑 Tracklist（曲目单）**：
  - 摒弃笨重的单篇大卡片与内嵌表单，采用现代音频曲目单设计（单行 52px 紧凑项）；
  - 每行清晰呈现：两位序数（如 `01`）、标题链接、收听进度与时长、精简播放胶囊按钮 `[ ▶ 播放 ]`、轻量删除垃圾桶；
  - 一屏内可完整容纳 4+ 个章节，极大降低浏览负荷；
- **创作域后置引导（听完即续）**：
  - 将原位于 Hero 头部的创作入口移至曲目单列表末尾，提供轻量引导卡片 `[ ✨ 续写这个故事集 ]` 与 `[ 📄 查看创作记录 ]`；
  - 顺应用户“听完本集或全部章节后自然想要续写下一集”的真实心智；
- **单篇物理删除确认弹窗**：
### 1.5 详情页播放控制按钮布局与空间合理性优化
- **消除文案冗余**：
  - 去除过长的“整集”字样，可见文案收敛为核心语义：`继续播放` 与 `从头播放`；
  - 保持 `aria-label="继续播放整集"` 与 `aria-label="从头播放整集"`，确保无障碍与自动化测试完全兼容。
- **主次视觉分层与尺寸瘦身**：
  - 主按钮（继续播放）：高亮实心胶囊（高度 36px，字号 13px，`padding: 0 16px`），作为主视觉行动点；
  - 次按钮（从头播放）：轻量半透明轮廓胶囊（高度 36px，字号 12px，`padding: 0 12px`），弱化对比度，作为辅助重置操作；
- **响应式单行布局（消除移动端垂直堆叠与空间膨胀）**：
  - 移除原小屏（`< 440px`）下将按钮强行换成 `flex-direction: column` 导致垂直高度翻倍的规则；
  - 移动端（iPhone 18 Pro / Pro Max）保持单行横向紧凑排列，仅占 36px 垂直高度；
  - 桌面端（PC）采用两端对齐横幅排版：左侧为故事集标题与元信息，右侧居右对齐播放控制组；
  - 头部卡片（Hero）整体内边距收敛（移动端 14px 16px，桌面端 16px 22px），垂直高度从 ~230px 骤减至 ~120px，释放了近 50% 的首屏纵向空间，让曲目单列表一目了然。

## 2. 验证与证据

- **自动化门禁**：
  - `yarn test:fast` (ESLint + TypeScript 类型检查) 0 错误 0 警告通过；
  - `yarn build` (Next.js 15 生产构建) 100% 成功。
- **端到端实机截图证据**：
  - `01-library-all-iphone18pro.png`: 故事库全量视图（整卡可点、从头开始按钮、收藏星标）；
  - `02-library-favorites-iphone18pro.png`: 故事库收藏 Tab（仅故事集，无多余子 Tab）；
  - `03-library-trash-iphone18pro.png`: 故事库回收站 Tab（仅故事集，无多余子 Tab）；
  - `04-collection-detail-tracklist-iphone18pro.png`: 合集详情页 Tracklist（一屏呈现 4 章节曲目单）；
  - `05-collection-detail-dropdown-iphone18pro.png`: 详情页右上角更多菜单；
  - `06-collection-rename-modal-iphone18pro.png`: 故事集重命名居中弹窗；
  - `07-work-delete-modal-iphone18pro.png`: 单篇作品彻底删除确认弹窗；
  - `08-collection-continuation-card-iphone18pro.png`: 列表末尾“续写故事集”自然引导卡片；
  - `09-library-pc-desktop.png`: PC 桌面端故事库响应式布局；
  - `10-collection-detail-pc-desktop.png`: PC 桌面端合集详情页 Tracklist 响应式布局；
  - `playback-actions-opt/01-collection-detail-buttons-iphone18pro.png`: 详情页播放按钮紧凑优化后（iPhone 18 Pro 全貌）；
  - `playback-actions-opt/02-hero-panel-zoom-iphone18pro.png`: 头部播放控制区域高倍特写；
  - `playback-actions-opt/03-collection-detail-buttons-iphone18promax.png`: iPhone 18 Pro Max 表现；
  - `playback-actions-opt/04-collection-detail-buttons-pc-desktop.png`: PC 桌面端左右两端对齐横幅。

