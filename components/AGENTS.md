# AGENTS

## 目录职责
- 存放全局可复用的 UI 组件与相关配置。
- 提供跨页面统一的界面交互与主题能力。

## 子目录结构
- `AntdMobileCompat/`：适配 antd-mobile 在 Next.js 中的运行环境。
- `AudioControllerHost/`：隐藏音频宿主，注册播放控制器并调度故事流程。
- `FloatingPlayer/`：悬浮播放器 Provider 与 UI。
- `PlaybackStatusBoard/`：播放倒计时与预加载状态展示。
- `MainTabBar/`：底部主导航组件。
- `Modal/`：通用模态框。
- `PageLoading/`：页面级加载组件。
- `StoryViewer/`：故事文本预览与弹窗展示。
- `ThemeProvider/`：主题上下文与脚本注入。

## 关键协作与依赖
- 组件依赖 `@/stores/**`、`@/utils/**` 提供的状态与工具。
- 对外以组件形式供 `app/` 与其他模块复用。
