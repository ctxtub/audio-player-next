# AGENTS

## 目录职责
- 主应用路由组，包含需要登录（或访客身份）才可访问的页面。
- 提供共享的主应用布局（`layout.tsx`）：ConfigInitializer、GuestBanner、TabBar、AudioControllerHost、FloatingPlayer。
- 访问受 `middleware.ts` 中的受保护路径守卫限制，未认证用户会被重定向至 `/auth`。

## 子目录结构
- `home/`：首页，音频播放器与输入状态展示。
- `chat/`：对话页，AI 故事生成交互。
- `setting/`：设置页，用户信息、播放偏好与主题配置。
- `layout.tsx`：主应用专属布局，不含 TabBar 等的根布局不在此处。
- `layout.module.scss`：主布局样式。

## 关键协作与依赖
- 依赖 `@/components/ConfigInitializer` 初始化全局配置。
- 依赖 `@/components/GuestBanner` 展示访客模式提示。
- 依赖 `@/stores/authStore` 判断登录/访客态。
- 中间件守卫来自 `middleware.ts`，认证逻辑依赖 `@/lib/session`。
