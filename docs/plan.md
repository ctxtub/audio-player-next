# BFF 与服务层改造方案

## 目标
- **BFF 层**：统一承担业务入参校验、错误映射与前端契约维护职责，仅向服务层传递经过校验的原子化请求。
- **服务层**：替换为对官方 SDK 的薄封装，OpenAI 文本生成使用 `openai` Node.js SDK，Azure 语音合成使用 `microsoft-cognitiveservices-speech-sdk`，不再保留自定义 HTTP 参数。
- **类型体系**：保持与 `@/types/story`、`@/types/ttsGenerate` 的兼容性，必要时扩展新的内部 DTO 用于 BFF 到服务层的映射。

## BFF 层接口定义
### `/api/storyGenerate`
```ts
// Request Body（与前端保持一致，BFF 内部校验）
export type StoryGenerateApiRequest = {
  mode: 'generate';
  prompt: string; // 需校验最小/最大长度、敏感词等业务规则
};

export type StoryContinueApiRequest = {
  mode: 'continue';
  prompt: string; // 用于引导续写，沿用生成同样的校验规则
  storyContent: string; // BFF 校验非空、最大字数限制
  withSummary?: boolean; // BFF 负责默认值与布尔规范化
};

export type StoryApiRequest = StoryGenerateApiRequest | StoryContinueApiRequest;

// Response Body（保持前端契约）
export type StoryApiResponse = {
  storyContent: string;
  summaryContent?: string | null;
};
```

**BFF 处理流程**
1. `POST` 请求体 JSON 解析失败时直接返回 `400 INVALID_JSON`。
2. 根据 `mode` 进行分支校验：
   - `prompt`：限制长度、过滤空白字符、可扩展敏感词检测。
   - `continue` 模式额外校验 `storyContent` 非空且长度合规；`withSummary` 转为布尔值。
3. 借助 BFF 内部的 `buildStoryMessages` 工具函数拼装 OpenAI 消息列表（系统提示词与时序策略完全由 BFF 维护，便于后续扩展其他业务能力）：
   - 生成模式：返回形如 `[{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]` 的数组。
   - 续写模式：在用户消息中包含已有故事与追加指令；若需要摘要则通过同一工具函数传入不同参数生成摘要专用消息序列。
4. 调用服务层 `invokeChatCompletion(messages)`，并在 BFF 内解析响应：
   - 从 `choices[0].message?.content` 或 `choices` 列表中提取故事文本，若无有效文本则返回 `502 UPSTREAM_BAD_RESPONSE`。
   - 当前阶段不消费 `usage` 字段，保持最小化响应处理逻辑。
   - 摘要场景复用同一接口，再次传入针对摘要定制的消息列表，并在 BFF 层解析摘要文本。
5. BFF 使用解析出的文本组装 `StoryApiResponse`（主内容 + 可选摘要），保持与现有前端契约一致。

**消息工具函数设计**
```ts
// app/api/storyGenerate/utils/buildStoryMessages.ts
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export type BuildStoryMessagesOptions =
  | { mode: 'generate'; systemPrompt: string; prompt: string }
  | {
      mode: 'continue';
      systemPrompt: string;
      prompt: string;
      storyContent: string;
      summaryMode?: boolean;
    };

export function buildStoryMessages(options: BuildStoryMessagesOptions): ChatCompletionMessageParam[] {
  // 依据模式拼装系统提示词与用户内容，BFF 在调用前已经完成输入裁剪与校验
}
```
- `summaryMode` 用于在需要摘要时定制用户消息内容；若业务扩展其他模式，可在此集中管理提示词与消息体。
- BFF 在路由处理中首先调用该函数获取消息数组，然后传递给 `invokeChatCompletion`。
完成消息解析后返回 `200` 与 `StoryApiResponse`；捕获 `ServiceError` 并映射状态码、错误码，保持与当前响应结构兼容以实现平滑迁移。

### `/api/ttsGenerate`
```ts
// Request Body
export type TtsGenerateApiRequest = {
  text: string; // BFF 校验长度、是否包含非法字符
  voiceId?: string; // BFF 校验是否在白名单内，若缺省则落到默认音色
};

// Response Body
// 直接返回 audio/mpeg 的二进制流，由 BFF 写入响应体
```

**BFF 处理流程**
1. JSON 解析失败返回 `400 INVALID_JSON`。
2. 校验 `text` 长度、剔除纯空白；`voiceId` 与配置白名单比对，缺省使用默认值。
3. 调用服务层 `synthesizeSpeech({ text, voiceId })` 获取 `ArrayBuffer`。
4. 设置 `Content-Type: audio/mpeg`，写入音频数据；异常捕获映射为统一错误响应。

## 服务层接口定义
### 文本生成（OpenAI SDK）
- 依赖包：`openai`。
- 配置：
  - `OPENAI_API_KEY`（必填）。
  - `OPENAI_BASE_URL`（可选，自定义代理时使用）。
  - `OPENAI_MODEL`（必填，用于 stories 与 summaries）。
  - 如需温度、最大 token 可通过环境变量提供默认值，但不在函数签名中暴露定制化字段。

```ts
// lib/server/storyUpstream/openaiClient.ts
export type StoryMessage = ChatCompletionMessageParam; // 直接复用 SDK 类型

/**
 * 使用官方 SDK 调用 Chat Completions，BFF 负责传入完整的消息序列与提示词。
 */
export async function invokeChatCompletion(messages: StoryMessage[]): Promise<OpenAI.Chat.Completions.ChatCompletion>;
```

实现要点：
1. 初始化 `OpenAI` 客户端时从配置读取 API Key、Base URL。
2. 调用 `client.chat.completions.create({ model, messages })`，不额外传入自定义 header/参数，并把返回的 `ChatCompletion` 结构原样交给 BFF，由 BFF 提取故事文本（当前阶段忽略 `usage`）。
3. 对 SDK 抛出的异常（`OpenAI.APIError` 等）转换为 `ServiceError`，保留状态码与错误信息。

### 语音合成（Azure Speech SDK）
- 依赖包：`microsoft-cognitiveservices-speech-sdk`。
- 配置：
  - `AZURE_SPEECH_KEY`、`AZURE_SPEECH_REGION`。
  - 语音白名单、默认音色继续通过现有配置模块维护（BFF 使用）。

```ts
// lib/server/ttsUpstream/azureSpeech.ts
export type SynthesizeSpeechParams = {
  text: string;
  voiceId: string; // BFF 已保证在白名单中
};

export type SynthesizeSpeechResult = {
  audioData: ArrayBuffer;
  requestId: string; // SDK 返回的 trace 信息，便于日志记录
};

/**
 * 使用 Azure Speech SDK 执行文本转语音，并返回音频二进制数据。
 */
export async function synthesizeSpeech(params: SynthesizeSpeechParams): Promise<SynthesizeSpeechResult>;
```

实现要点：
1. 构造 `SpeechConfig.fromSubscription(key, region)`，设置 `speechSynthesisVoiceName = voiceId`，`speechSynthesisOutputFormat = SpeechSynthesisOutputFormat.Audio24Khz160KBitRateMonoMp3`（或依据性能要求调整为任意官方支持格式）。
2. 直接使用 `new SpeechSynthesizer(speechConfig)`（无需绑定本地输出设备），SDK 会在返回的 `SpeechSynthesisResult` 中附带 MP3 字节数组 `audioData`，避免额外的流式拼装或本地转码。
3. 在 `speakTextAsync` 成功回调中读取 `result.audioData` 与 `result.requestId`，转换为 `ArrayBuffer` 后返回给 BFF。
4. 处理 `CancellationDetails`、`result.reason !== ResultReason.SynthesizingAudioCompleted` 等失败分支，转换为 `ServiceError`。
5. `SpeechSynthesizer`、`SpeechConfig` 等实例在完成一次合成后需显式调用 `close()` 释放资源；由于当前调用量较低，可按“即用即建、完成后立即关闭”的策略实现，避免引入额外的连接池复杂度。

## 实施步骤
1. **依赖与配置**：在 `package.json` 新增 `openai`、`microsoft-cognitiveservices-speech-sdk`，更新环境配置加载逻辑。
2. **服务层重构**：
   - 新建 `openaiClient.ts`、`azureSpeech.ts`，实现上述函数。
   - 移除旧的 HTTP 调用封装与 `performChatCompletion`、自定义 `synthesizeSpeech`。
3. **BFF 重写**：
   - 在 `/api/storyGenerate`、`/api/ttsGenerate` 内完成所有业务校验并调用新的服务层函数。
   - 更新错误码映射、日志记录与响应结构。
4. **类型与测试**：
   - 若 BFF 新增内部 DTO，确保与 `@/types/story`、`@/types/ttsGenerate` 对齐。
   - 运行 `yarn lint`、`yarn tsc --noEmit` 验证。

## 风险与待确认事项
- OpenAI SDK 版本选择：推荐使用 `chat.completions` 稳定接口；若迁移到 `responses` API 需同步调整消息结构。
- Azure Speech SDK 在 Node.js 环境的内存占用需评估，当前按“即用即关”策略即可满足需求，后续若调用量大幅提升再评估复用方案。
- 需确认现有业务是否依赖旧的错误码或响应字段，BFF 改造后需保持兼容，并通过对比现有实现确保迁移过程保持功能一致。

## 平滑迁移策略
- 在提交代码前对比现有 BFF 响应结构与错误码，确保新的实现仍满足前端调用方的断言。
- 通过单元测试或本地调试验证生成故事、续写、语音合成三大主流程，确认在 SDK 替换后体验无差异。
- 渐进式上线时先在测试环境部署新的 BFF/服务层实现，完成回归后再同步推广至生产环境。
