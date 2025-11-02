# AGENTS

## 目录职责
- 提供 antd-mobile 在 App Router 环境下的兼容处理。
- 注入必要脚本，避免客户端组件渲染异常。

## 子目录结构
- `index.tsx`：组件实现。

## 关键协作与依赖
- 在 `app/layout.tsx` 中注入以确保全局生效。
