# AGENTS

## 目录职责
- 登录/注册/访客入口页面，路由地址 `/auth`。
- 提供三种进入应用的方式：账号登录、新用户注册、访客模式。
- 通过 `safeRedirect` 处理 `?from=` 参数，防止开放重定向攻击。

## 子目录结构
- `index.tsx`：页面实现，含登录/注册 Tabs 表单与访客按钮。
- `index.module.scss`：页面样式（Logo 区、表单卡片、Tabs、访客分隔）。
- `page.tsx`：Next.js 页面导出。

## 关键协作与依赖
- 依赖 `@/stores/authStore`（`login`、`register`、`enterGuestMode` actions）。
- 表单验证通过 antd-mobile Form + Zod Schema（`@/lib/trpc/schemas/auth`）双端保证。
- 成功后跳转使用 `router.replace`（不留历史）至 `safeRedirect` 校验后的目标路径。
