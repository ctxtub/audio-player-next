# AGENTS

## 目录职责
- 提供消息片段渲染器注册表，根据 `MessagePart.type` 自动分发到对应渲染组件。
- 采用注册表模式，新增片段类型只需添加渲染组件并注册。

## 子目录结构
- `index.tsx`：分发器组件与渲染器注册表。
- `TextPart.tsx`：文本片段渲染器。
- `StoryCardPart.tsx`：故事卡片片段渲染器，支持多阶段展示（生成文本/音频/播放）。
- `GuidancePart.tsx`：指令确认片段渲染器，展示系统生成的引导或确认指令。
- `index.module.scss`：共享样式，复用 GenerationPreview 视觉风格。

## 关键协作与依赖
- 依赖 `@/types/chat` 中的 `MessagePart` 联合类型。
- `StoryCardPart` 订阅 `@/stores/generationStore` 获取当前生成阶段，订阅 `@/stores/playbackStore` 实时响应播放状态（图标切换/高亮）。
- 被 `MessageBubble` 组件调用进行消息内容渲染。
- 故事播放通过 `onPlayStory` 回调触发 `FloatingPlayer`，或直接调用 store 方法暂停。
