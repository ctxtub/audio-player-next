# AGENTS

## 目录职责
- 访客模式提示横幅组件，仅在 `isGuest=true` 时渲染，引导用户注册正式账号。
- 作为全局布局的一部分，挂载于 `app/(main)/layout.tsx` 顶部。

## 子目录结构
- `index.tsx`：组件实现，监听 authStore 的 `isGuest` 与 `initialized` 状态。
- `index.module.scss`：横幅样式。

## 关键协作与依赖
- 依赖 `@/stores/authStore`：读取 `isGuest`、`initialized`，调用 `fetchProfile`（含竞态保护）。
- 点击"注册账号"按钮跳转至 `/auth?from=<当前路径>`。
- 渲染条件：`initialized && isGuest`，避免闪烁。
