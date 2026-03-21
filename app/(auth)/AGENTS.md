# AGENTS

## 目录职责
- 认证路由组，包含登录/注册/访客入口页面。
- 提供独立的全屏布局（`layout.tsx`），不含 TabBar、AudioController 等主应用布局元素。
- 已登录用户访问此路由组时，由 `middleware.ts` 反向守卫自动重定向至 `/home`。

## 子目录结构
- `auth/`：登录、注册、访客模式入口页，含 Tabs 切换表单与 `safeRedirect` 防重定向攻击。
- `layout.tsx`：认证专属全屏布局。
- `layout.module.scss`：认证布局样式。

## 关键协作与依赖
- 依赖 `@/stores/authStore` 执行登录/注册/进入访客模式操作。
- 认证成功后通过 `router.replace(safeRedirect(from))` 跳回来源页。
- 中间件反向守卫来自 `middleware.ts`，会话解码依赖 `@/lib/session`。
