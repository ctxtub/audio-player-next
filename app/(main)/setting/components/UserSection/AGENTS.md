# AGENTS

## 目录职责
- 展示设置页的用户信息模块，并提供登录/登出交互。
- 内部包含登录弹窗与表单逻辑，统一管理状态。

## 子目录结构
- `index.tsx`：组件实现。
- `index.module.scss`：样式文件。

## 关键协作与依赖
- 依赖 `@/stores/authStore` 获取登录状态与操作。
- 使用 `@/components/Modal` 与 antd-mobile 表单组件构建 UI。
