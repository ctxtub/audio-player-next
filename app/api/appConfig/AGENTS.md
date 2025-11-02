# AGENTS

## 目录职责
- 暴露应用运行时配置的 GET 接口。
- 聚合语音音色配置与前端默认播放参数。

## 子目录结构
- `route.ts`：实现 API Route 处理流程。

## 关键协作与依赖
- 依赖 `@/lib/server/ttsUpstream/config` 解析环境变量。
- 通过 `@/types/appConfig` 定义响应结构。
