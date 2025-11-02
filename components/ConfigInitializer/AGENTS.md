## 目录职责
- 提供配置初始化的全局组件，统一触发配置拉取与加载态展示。

## 子目录结构
- `index.tsx`：导出配置加载组件。

## 关键协作与依赖
- 依赖 `@/stores/configStore` 获取配置初始化与状态。
- 依赖 `@/components/PageLoading` 在未完成初始化时显示加载态。
