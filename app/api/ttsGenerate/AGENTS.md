# AGENTS

## 目录职责
- 暴露语音合成代理接口，供前端生成音频。
- 校验请求参数并返回二进制流或错误信息。

## 子目录结构
- `route.ts`：API Route 实现。

## 关键协作与依赖
- 依赖 `@/lib/server/ttsUpstream` 调用 Azure TTS。
- 使用 `@/types/ttsGenerate` 校验请求体。
