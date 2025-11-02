# AGENTS

## 目录职责
- 管理应用主题上下文，支持深浅色切换。
- 在服务端注入初始主题脚本，避免闪烁。

## 子目录结构
- `index.tsx`：主题 Provider 与 Hook。
- `themeConfig.ts`：主题配色与脚本配置。

## 关键协作与依赖
- 被 `app/layout.tsx` 引用，为全局组件提供主题能力。
- 与 `@/stores/configStore` 协作更新用户选择的主题。
