# AGENTS

## 目录职责
- 管理全局样式与公共样式资源。

## 子目录结构
- `index.css`：全局样式入口，负责注入 Tailwind 并串联下游层级文件。
- `theme.css`：主题令牌与 Reset 定义，集中声明 `--color-*`、`--size-*` 等 CSS 自定义属性。
- `semantic.css`：语义化样式入口，统筹导入 `semantic/` 目录下的组合类模块。
- `semantic/`：拆分后的语义类与第三方覆盖模块，详见该目录 `AGENTS.md`。
- `themeTokens.ts`：复用 `tokens/designTokens.ts` 导出的 Tailwind 映射，避免重复配置。
- `tokens/designTokens.ts`：统一维护设计令牌命名，提供 Tailwind `extend` 引用与变量索引。

## 关键协作与依赖
- 由 `app/layout.tsx` 等入口文件加载，影响全局 UI。

## 基础样式类速查
- **语义组合类**
  - `surface-card`：玻璃态卡片基础容器，包含圆角、阴影、模糊与主题过渡。
  - `surface-panel`：主色玻璃面板底色，用于浮窗、弹层等强调场景。
  - `btn-chip`/`btn-chip--history`：快捷标签按钮与历史入口变体，自动处理禁用态与 hover/active 动效。
  - `btn-primary`：块级主操作按钮，配合 `min-w-[var(--size-min-width-button)]` 控制最小宽度。
  - `btn-circle-primary`：圆形主色按钮，带背景/阴影渐变；常用于浮窗播放键。
  - `btn-speed-control`：倍速菜单触发按钮，含玻璃态背景与 scale 动效，宽度由 `--size-width-icon` 管理。
  - `input-surface`：玻璃态输入框皮肤，与 `btn-primary` 组合组成输入+操作区域。

- **色板与文本**
  - 背景：`bg-background`、`bg-background-initial`、`bg-page-background`、`bg-surface`、`bg-surface-overlay`、`bg-surface-primary-soft/medium/strong`、`bg-surface-process`、`bg-surface-success`、`bg-surface-error`。
  - 边框：`border-border-card`、`border-border`、`border-border-primary`、`border-border-process`、`border-border-primary-blend`。
  - 文本：`text-foreground`、`text-foreground-secondary`、`text-primary`、`text-process`、`text-success`、`text-error`。

- **间距与圆角**
  - 间距：`xs`(5px)、`sm`(10px)、`md`(15px)、`lg`(20px)、`xl`(30px) 对应 `p-*`/`m-*`/`gap-*`。
  - 圆角：`rounded-lgx`(10px)、`rounded-lg-plus`(15px)、`rounded-xl`(12px)、`rounded-xl-plus`(18px)、`rounded-modal`(20px)。

- **阴影与玻璃态**
  - 背景模糊统一使用 `backdrop-blur-soft`、`backdrop-blur-panel` 等约定值，特殊场景可使用 `var(--blur-glass)` 自定义。
  - 阴影层级：`shadow-floating`（浮层默认）、`shadow-panel`（大面积图卡）、`shadow-surface-sm/md/lg`（轻量卡片）、`shadow-primary-glow` 族（主色强调）、`shadow-surface-top`（顶部阴影）。
  - CSS 变量：`--shadow-*` 与 `--blur-*` 已在 `theme.css` 定义，可在局部 CSS Module 内直接复用。

- **过渡与动画**
  - 过渡时长/缓动统一搭配 `transition-*` + `duration-theme` + `ease-theme`。
  - 常用动效：悬浮上移 `hover:-translate-y-0.5`、按钮缩放 `hover:scale-105`/`active:scale-95`、加载旋转 `animate-spin`。

- **尺寸令牌**
  - 全局尺寸通过 `--size-*` 变量维护，例如 `--size-max-width-modal`、`--size-width-disc`、`--size-min-height-input`。
  - 组件若需使用尺寸，推荐：
    - Tailwind 任意值写法：`max-w-[var(--size-max-width-modal)]`、`min-w-[var(--size-min-width-status)]`。
    - 或在局部 CSS Module 中定义 `.disc { width: var(--size-width-disc); }` 等封装。

- **使用约定**
  - 优先选择上面的语义化类组合，缺少的尺寸/圆角/空隙时优先复用 `--size-*` 变量，通过任意值或 CSS Module 处理。
  - 若需新增全局令牌，请先在 `tokens/designTokens.ts` 中登记变量命名，再于 `theme.css` 定义实际值，并在本文件补充说明。
