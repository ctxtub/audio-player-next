# AGENTS

## 目录职责
- 定义聊天页面的整体布局，将头部信息、消息展示与输入区域组合。
- 提供容器化子组件以承载后续业务实现。

## 子目录结构
- `index.tsx`：布局主组件，拼装头部、消息与输入区域。
- `index.module.scss`：布局样式，定义列布局与滚动行为。
- `HeaderArea.tsx` / `HeaderArea.module.scss`：顶部导航栏区域，展示对方昵称等信息。
- `MessageArea.tsx`：消息展示容器，负责滚动区域占位。
- `InputArea.tsx`：输入区容器，承载消息输入操作占位。
- `types.ts`：组件 Props 与相关类型定义。

## 关键协作与依赖
- 自身消费 `stores/chatStore` 等全局状态，不再依赖父组件通过 Props 传入会话数据。
- 后续可与实时消息数据、输入控件等模块衔接。
