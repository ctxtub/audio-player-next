# AGENTS

## 目录职责
- 承载对话页面的服务端渲染入口，组织聊天体验的页面骨架。
- 聚合服务器侧数据（如用户昵称、会话标识）并透出给下游布局组件。
- 调度本地组件呈现聊天顶部栏、消息列表与输入区域。

## 子目录结构
- `components/`：存放聊天页面私有组件与布局拆分。
- `index.tsx`：聊天页面的 Server Component 壳，加载布局并传递服务端数据。
- `page.tsx`：Next.js 路由入口，仅转发至 `index.tsx`。

## 关键协作与依赖
- 将会话元数据传入 `components/ChatLayout` 完成 UI 组织。
- 预留与 `@/stores/**`、`@/app/services/**` 的交互以支撑后续实时聊天能力。
