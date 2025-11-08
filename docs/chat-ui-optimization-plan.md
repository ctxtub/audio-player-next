# /chat 页面 UI 优化技术方案

## 背景
结合现有 `/chat` 页面实现与最新设计稿，页面需补齐顶部欢迎与引导区域、头像化的消息气泡、精简图标发送的输入区以及渐变背景等视觉细节。本方案按照“产品任务拆解”四个目标输出可落地的前端实现方案。

## 方案总览
- **技术栈保持**：沿用 Next.js 15 + React 19 + TypeScript + antd-mobile 5，客户端组件继续使用 Zustand 的 `useChatStore`；避免破坏现有服务端渲染与消息流转逻辑。
- **布局层级**：页面结构调整为“顶部欢迎区 → 消息区 → 输入区”，消息区继续负责滚动与流式渲染，顶部与底部模块保持固定高度以避免滚动冲突。
- **主题适配**：通过 CSS 自定义属性及 `.module.scss` 维护的渐变背景与阴影，确保深浅主题下的对比度与可读性；优先复用变量，必要时新增局部变量并写入 `:root`（若与全局主题耦合再交互评估）。
- **组件复用策略**：优先选用 antd-mobile 组件（`Avatar`、`Button`、`Grid`、`List`、`Tag` 等），若设计稿需求无法满足再实现轻量自定义组件。

## 详细方案

### 1. 构建顶部欢迎与推荐建议区
1. **新增组件结构**：
   - 在 `app/chat/components/ChatLayout` 目录下创建 `HeaderArea.tsx`（客户端组件）及配套 `HeaderArea.module.scss`。
   - 组件导出 `HeaderArea`，接收 `onSuggestionSelect: (value: string) => void`、`visible: boolean` 等 props，用于控制显隐与点击行为。
2. **UI 组成**：
   - 头部信息使用 antd-mobile `List` 或自定义 flex，左侧放置 `Avatar`（助手 Logo），右侧包含主标题、副标题文案，文案支持通过配置注入以便后续 A/B。
   - 推荐提问区域使用 antd-mobile `Grid`/`Space` 搭配 `Button` 或 `Tag` 组件实现卡片，按钮触发 `onSuggestionSelect`。
   - 如需折叠（存在历史消息时隐藏），可通过 `visible` 控制渲染；或在 `ChatLayout` 根据 store 中消息数量判断。
3. **状态接入**：
   - `ChatLayout` 在渲染时根据 `messages.length === 0` 决定 `HeaderArea` 是否展示，历史会话可折叠。
   - 点击建议按钮时调用 `beginChatStream` 或将文案写入 `Composer` 的输入框。建议通过 `useChatStore` 暴露 `setInputValue` 方法（若不存在则新增），避免直接操作 DOM。
4. **样式要求**：
   - `HeaderArea.module.scss` 使用渐变背景或透明白底，与主体背景融合；边距使用 `var(--app-padding)` 等自定义属性。
   - 添加轻量阴影与圆角，保证顶部内容在滚动时与消息区有视觉分层。

### 2. 升级消息气泡为头像+昵称样式
1. **数据结构扩展**：
   - 在 `app/chat/components/ChatLog/types.ts`（若无则新建）或现有消息定义处扩展 `displayName`、`avatar`，默认基于角色枚举映射，后续兼容真实用户信息。
   - 若扩展 store 结构，需在 `stores/chatStore`（实际路径以仓库为准）中补充默认值与 selector。
2. **组件更新**：
   - 修改 `MessageBubble.tsx`：引入 antd-mobile `Avatar` 与 `Space`，整体结构调整为头像+内容横向排列，内容块内包含昵称、正文、附加状态（发送中、失败）。
   - 保留原有 `status`、`onRetry` 逻辑，将状态信息显示在气泡右上角或底部。
3. **样式调整**：
   - 在 `MessageBubble.module.scss` 中新增头像尺寸、气泡圆角、不同角色的配色（助手浅色、用户主色）。
   - 将昵称文本放置于气泡上方或内部顶部，通过 `font-size: 12px`、`color: var(--text-secondary)` 区分主次信息。
   - 为长文本提供 `word-break: break-word`，确保移动端显示稳定。
4. **无头像回退**：
   - 使用默认头像（助手用品牌图标，用户用首字母或通用图案）。资源放于 `public/icons`，并在 `MessageBubble` 中集中管理引用。

### 3. 重构 Composer 以匹配图标发送交互
1. **布局拆分**：
   - 调整 `Composer.tsx` 结构为左侧保留占位操作区（可根据后续需求挂载更多按钮）、中间 `TextArea`、右侧悬浮发送按钮。
   - 继续使用 antd-mobile `TextArea`，在 `textareaRef`、快捷键等现有逻辑不变前提下，迁移样式类名，并移除与语音输入相关的状态或 Hook。
2. **按钮实现**：
   - 左侧仅保留容器（如 `div` 或 `Space`），默认留空；若设计稿需要其它动作（附件、表情等）可后续追加，此轮不展示麦克风图标。
   - 右侧发送按钮使用圆形 `Button` 或 `FloatingBubble`，内嵌 `SendOutline` 图标。保持发送中禁用状态（禁用/展示 loading 图标）。
3. **交互细节**：
   - placeholder 修改为 “Type a message...”，支持多语言后期抽离。
   - 输入框高度 `autoSize`，最大高度约 120px，超出后内部滚动。
   - 处理键盘弹起时的安全距离，可结合 `env(safe-area-inset-bottom)`。
4. **样式**：
   - 新增 `Composer.module.scss` 中的布局类，使用 `backdrop-filter` 与渐变背景，边框圆角与设计稿一致，并删除麦克风按钮相关样式避免冗余。
   - 确保与底部 `MainTabBar` 不重叠，必要时调整 `padding-bottom`。

### 4. 统一聊天页面背景与视觉层级
1. **页面容器**：
   - 在 `app/chat/index.module.scss` 与 `ChatLayout` 样式中添加渐变背景（如 `linear-gradient(180deg, rgba(...) 0%, ...)`），并确保 `min-height: 100vh`。
   - 调整 `MessageArea` 外层为 `overflow-y: auto`，上下 padding 避免消息紧贴。
2. **滚动与阴影**：
   - 为顶部 `HeaderArea` 与底部 `Composer` 添加 `box-shadow` 或 `mask-image` 营造分层感。
   - 使用 CSS 自定义属性控制阴影颜色，在深色模式下使用 `rgba(0,0,0,0.4)`。
3. **导航适配**：
   - 检查 `components/MainTabBar` 占位高度；`ChatLayout` 底部需留出 `padding-bottom: calc(var(--tab-bar-height) + env(safe-area-inset-bottom))`。
   - 若页面已通过布局容器处理，则仅调整数值，避免多重 padding。
4. **状态空白页**：
   - 在 `ChatLog` 中保持空状态提示与加载动画，与新背景协调；必要时更新样式文件中的颜色变量。

## 实施步骤建议
1. 按目标分支实现，建议顺序：Header → MessageBubble → Composer → 样式统一。
2. 每完成一个目标进行自测（视觉检查 + 消息发送流程）；重点关注流式响应与自动滚动是否受影响。
3. 最后运行 `yarn lint`、`yarn tsc --noEmit`、`yarn build` 验证。

## 风险与对策
- **样式覆盖冲突**：新增模块可能影响现有 `flex` 布局，需在 CSS 中限定类名作用域，并保持组件 `flex: 1` 仅用于消息区域。
- **Store 扩展风险**：若新增字段放入 store，需保证初始化与恢复逻辑一致；可通过选择器包装避免透出内部结构。
- **SSR/CSR 差异**：`HeaderArea` 可能依赖 `window`（如欢迎语动画）时，需保持纯 UI，不访问浏览器 API，确保 SSR 稳定。

## 验收标准
- 顶部欢迎区在首次进入或无历史消息时展示，推荐提问点击后可快速填充输入区或直接发起对话。
- 消息列表展示头像、昵称、状态，助手与用户的配色与设计稿一致，长消息排版良好。
- 输入区展示精简的文本输入与图标化发送按钮，键盘弹起时布局稳定，后续可无缝扩展其它快捷动作。
- 页面背景渐变、阴影、底部导航衔接顺畅，在浅色主题下视觉贴合设计稿。

