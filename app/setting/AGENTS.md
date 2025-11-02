# AGENTS

## 目录职责
- 实现应用设置页面，允许调整播放时长、语音音色及主题模式。
- 管理设置相关的本地组件与样式。

## 子目录结构
- `components/`：设置页专用组件集合。
- `index.tsx`：页面实现。
- `page.tsx`：Next.js 页面导出。
- `index.module.scss`：页面样式。

## 关键协作与依赖
- 依赖 `@/stores/configStore`、`@/components/ThemeProvider` 获取配置和主题。
- 与 `@/components/**`、`@/lib/client/appConfig` 协同确保配置同步。
