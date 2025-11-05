# AGENTS

## 目录职责
- 维护统一的设计令牌定义，集中描述颜色、尺寸等抽象。

## 子目录结构
- `designTokens.ts`：导出设计令牌结构与 Tailwind 映射。

## 关键协作与依赖
- `styles/theme.css` 引用此处声明的 CSS 变量命名，确保视觉值来源一致。
- `styles/themeTokens.ts` 复用导出的 `tailwindThemeExtension`，避免与 Tailwind 配置重复维护。

## 维护约定
- 新增或调整令牌时，优先在此处更新，并同步检查 `theme.css` 是否已定义相应 CSS 变量。
- 若引入新的主题变体，需要扩展 `designTokens.ts` 中的主题映射与文档说明。
