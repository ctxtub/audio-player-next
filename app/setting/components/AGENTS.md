# AGENTS

## 目录职责
- 存放设置页面的拆分组件，负责具体配置项的展示与交互。
- 保持组件职责单一，便于后续扩展更多配置模块。

## 子目录结构
- `BasicConfigSection.tsx`：基础播放配置表单。
- `ThemeModeSection.tsx`：主题模式选择组件。
- `VoiceServiceSection.tsx`：语音音色配置表单。

## 关键协作与依赖
- 使用 `@/stores/configStore` 与页面层共享状态更新。
- 依赖 `@/components/ThemeProvider` 获取主题上下文。
