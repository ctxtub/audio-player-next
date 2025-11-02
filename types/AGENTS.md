# AGENTS

## 目录职责
- 定义跨模块复用的业务类型，保障 TypeScript 严格模式下的类型安全。

## 子目录结构
- `appConfig.ts`：应用运行时配置类型。
- `story.ts`：故事生成与续写相关类型。
- `theme.ts`：主题配置类型。
- `ttsGenerate.ts`：语音合成请求与响应类型。

## 关键协作与依赖
- 被 `@/app/**`、`@/lib/**`、`@/stores/**` 广泛复用。
