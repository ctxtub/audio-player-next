import OpenAI from "openai";

import { loadOpenAiEnvConfig, type OpenAiEnvConfig } from "./env";

/**
 * 复用的 OpenAI 官方 SDK 客户端实例，避免在每次请求时重复创建。
 */
let cachedClient: OpenAI | null = null;

/**
 * 根据传入的配置创建或返回复用的 OpenAI 客户端。
 * @param config 解析后的环境变量配置，默认从 `loadOpenAiEnvConfig` 获取。
 */
export const getOrCreateOpenAiClient = (
  config: OpenAiEnvConfig = loadOpenAiEnvConfig(),
): OpenAI => {
  if (cachedClient) {
    return cachedClient;
  }

  cachedClient = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });

  return cachedClient;
};

/**
 * 重置缓存的 OpenAI 客户端，便于测试场景模拟不同配置。
 */
export const resetOpenAiClient = (): void => {
  cachedClient = null;
};
