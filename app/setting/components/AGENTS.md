# AGENTS

## 目录职责
- 存放设置页面的功能区域组件。
- 对设置项按业务领域进行拆分，保持页面入口简洁。

## 子目录结构
- `BasicConfigSection.tsx`：基础配置区域（时长、自动播放）。
- `FloatingPlayerSection.tsx`：浮动播放器开关区域。
- `ThemeModeSection.tsx`：暗黑模式切换区域。
- `VoiceServiceSection.tsx`：语音服务选择区域。
- `UserSection/`：用户资料与登录态管理区域。

## 关键协作与依赖
- 被 `app/setting/index.tsx` 引用以组装页面。
- 各 Section 直接订阅 `@/stores/configStore` 或 `@/stores/authStore` 进行读写。
