# AGENTS

## 目录职责
- 提供 Next.js App Router 下的 API Route，实现与客户端交互的 HTTP 接口。
- 整合服务端业务逻辑与上游代理，确保返回结构统一。
- 处理异常转换与响应头设置。

## 子目录结构
- `appConfig/`：应用运行时配置接口。
- `storyGenerate/`：故事生成与续写接口。
- `ttsGenerate/`：语音合成接口。

## 关键协作与依赖
- 依赖 `@/lib/server/**` 访问上游 LLM 与 TTS 服务。
- 通过 `@/types/**` 确保请求与响应类型安全。
- 与客户端 `@/lib/client/**`、`@/stores/**` 配合完成业务流程。
