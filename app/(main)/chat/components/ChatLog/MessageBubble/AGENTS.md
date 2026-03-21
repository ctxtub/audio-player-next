# AGENTS

## 目录职责
- 渲染单条消息的气泡形态，包含不同角色与状态的视觉差异，并提供「思考中」状态的流光文字与节奏跳跃点动效。

## 子目录结构
- `index.tsx`：消息气泡组件实现。
- `MessageBubble.module.scss`：消息气泡样式定义。

## 关键协作与依赖
- 使用 `ChatLog` 目录下的类型定义，保持接口一致。
- 状态色彩参考播放器组件的 `var(--primary)`, `var(--success)`, `var(--error)` 等主题变量。
