# AGENTS

## 目录职责
- 提供消息片段渲染器注册表，根据 `MessagePart.type` 自动分发到对应渲染组件。
- 采用注册表模式，新增片段类型只需添加渲染组件并注册。

## 子目录结构
- `index.tsx`：分发器组件与渲染器注册表。
- `TextPart.tsx`：文本片段渲染器。
- `StoryCardPart.tsx`：故事卡片片段渲染器，支持多阶段展示（生成文本/音频/播放）。
- `index.module.scss`：共享样式，复用 GenerationPreview 视觉风格。

## 关键协作与依赖
- 依赖 `@/types/chat` 中的 `MessagePart` 联合类型。
- `StoryCardPart` 订阅 `@/stores/generationStore` 获取当前生成阶段。
- 被 `MessageBubble` 组件调用进行消息内容渲染。
- 故事播放通过 `onPlayStory` 回调触发 `FloatingPlayer`。
