# AGENTS

## 目录职责
- 拆分维护语义化组件样式与第三方库覆盖，方便组合复用。

## 文件说明
- `surfaces.css`：定义卡片、面板、浮层等表面相关组合类。
- `buttons.css`：抽象按钮、圆形操作、倍速控制等交互组件样式。
- `forms.css`：表单输入皮肤与交互状态控制。
- `vendor-antd-mobile.css`：集中管理 antd-mobile 组件的主题覆盖与变量映射。

## 协作关系
- 由 `styles/semantic.css` 汇总引入，供 `styles/index.css` 注入全局作用域。
- 与 `styles/theme.css`/`styles/themeTokens.ts` 共用设计令牌，新增语义类前需确认变量已存在。

## 维护约定
- 新增语义类时遵循 `@layer components` 包裹，保证 Tailwind 层级一致。
- 若新增模块文件，请同步更新本说明并在 `styles/semantic.css` 登记导入顺序。
