# AGENTS

## 目录职责
- 提供聊天输入组合组件，封装文本输入框、操作插槽与发送按钮。
- 管理基础交互（快捷键、loading、错误反馈），对外暴露轻量 props。

## 文件说明
- `Composer.tsx`：组件实现（客户端组件）。
- `Composer.module.scss`：局部样式，保持与首页输入模块的圆角与阴影一致。

## 协作约束
- 禁止在组件内部直接访问全局 store，所有状态经由 props 传入。
- Toast 反馈需统一使用 `antd-mobile` 的 `Toast.show`。
