import { ServiceError } from "@/lib/http/server/ErrorHandler";

/**
 * OpenAI 客户端所需的环境变量配置结构。
 */
export type OpenAiEnvConfig = {
  /** OpenAI 接口使用的 API Key。 */
  apiKey: string;
  /** OpenAI 接口的可选自定义 Base URL。 */
  baseUrl?: string;
  /** 调用 Chat Completions 时使用的模型名称。 */
  model: string;
  /** 通过环境变量设置的默认采样温度，可选。 */
  temperature?: number;
  /** 通过环境变量设置的最大输出 token 数，可选。 */
  maxTokens?: number;
};

/**
 * 必须存在的环境变量键名列表。
 */
const REQUIRED_ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_MODEL"] as const;

/**
 * 缓存的 OpenAI 环境配置，避免多次解析环境变量。
 */
let cachedConfig: OpenAiEnvConfig | null = null;

/**
 * 尝试把环境变量转换为数字，失败时返回 undefined。
 * @param raw 环境变量的原始取值。
 */
const parseNumberFromEnv = (raw: string | undefined): number | undefined => {
  if (!raw?.trim()) {
    return undefined;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    return undefined;
  }

  return parsed;
};

/**
 * 读取并缓存 OpenAI 调用所需的环境变量配置。
 * @returns 结构化的 OpenAI 配置对象。
 * @throws ServiceError 当缺少必填环境变量时抛出。
 */
export const loadOpenAiEnvConfig = (): OpenAiEnvConfig => {
  if (cachedConfig) {
    return cachedConfig;
  }

  const missingKeys = REQUIRED_ENV_KEYS.filter((key) => !process.env[key]?.trim());
  if (missingKeys.length > 0) {
    throw new ServiceError({
      message: `缺少必要的环境变量: ${missingKeys.join(", ")}`,
      status: 500,
      code: "SERVER_CONFIG_ERROR",
    });
  }

  const apiKey = String(process.env.OPENAI_API_KEY).trim();
  const rawBaseUrl = process.env.OPENAI_BASE_URL?.trim();
  const baseUrl = rawBaseUrl ? rawBaseUrl.replace(/\/+$/, "") : undefined;

  const model = String(process.env.OPENAI_MODEL).trim();
  const temperature = parseNumberFromEnv(process.env.OPENAI_TEMPERATURE);
  if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
    throw new ServiceError({
      message: "OPENAI_TEMPERATURE 必须在 0 到 2 之间",
      status: 500,
      code: "SERVER_CONFIG_ERROR",
    });
  }

  const maxTokens = parseNumberFromEnv(process.env.OPENAI_MAX_TOKENS);
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
    throw new ServiceError({
      message: "OPENAI_MAX_TOKENS 必须是正整数",
      status: 500,
      code: "SERVER_CONFIG_ERROR",
    });
  }

  const resolvedConfig: OpenAiEnvConfig = {
    apiKey,
    baseUrl,
    model,
  };

  if (temperature !== undefined) {
    resolvedConfig.temperature = temperature;
  }

  if (maxTokens !== undefined) {
    resolvedConfig.maxTokens = maxTokens;
  }

  cachedConfig = resolvedConfig;
  return resolvedConfig;
};

/**
 * 重置缓存的 OpenAI 环境配置，便于测试或热更新场景。
 */
export const resetOpenAiEnvConfig = (): void => {
  cachedConfig = null;
};
