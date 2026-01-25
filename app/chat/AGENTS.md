# AGENTS

## 目录职责
- 承载对话页面的客户端渲染入口，组织聊天体验的页面骨架。
- 调度本地组件呈现聊天顶部栏、消息列表与输入区域。

## 子目录结构
- `components/`：存放聊天页面私有组件与布局拆分。
- `index.tsx`：聊天页面的页面级组件。
- `page.tsx`：Next.js 路由入口，仅转发至 `index.tsx`。
- `index.module.scss`：聊天页面容器样式。

## 关键协作与依赖
- 引用 `components/ChatLayout` 完成 UI 组织（数据状态由其内部消费 store）。
- 预留与 `@/stores/**`、`@/app/services/**` 的交互以支撑后续实时聊天能力。
- 承载聊天体验相关的页面与组件，实现对话输入与消息呈现。
- 对接故事生成与音频播放能力，为未来聊天交互提供扩展点。
- 复用 `@/components/**` 与 `antd-mobile` 提供的基础 UI 能力。
