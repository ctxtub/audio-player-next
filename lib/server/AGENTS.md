# AGENTS

## 目录职责
- 存放服务端核心业务逻辑与第三方服务集成代码。
- 负责与 OpenAI API 等上游服务进行直接通信，管理密钥与请求配置。

## 子目录结构
- `openai.ts`：OpenAI SDK 的初始化与 Chat/Audio (含语速控制) 接口封装。

## 关键协作与依赖
- 读取 `process.env` 获取 API Key，必须配置 `OPENAI_MODEL_STORY` 和 `OPENAI_MODEL_AGENT`。
- 被 `@/lib/trpc/routers` 调用以执行实际的业务逻辑。
