import { ChatOpenAI } from "@langchain/openai";
import { getOpenAIConfig } from "@/lib/server/openai";

/**
 * 获取统一配置的 ChatOpenAI 实例。
 * 复用现有的环境变量配置。
 */
export const getAgentModel = () => {
    const config = getOpenAIConfig();

    return new ChatOpenAI({
        openAIApiKey: config.apiKey,
        modelName: config.model,
        temperature: config.temperature ?? 0.7,
        configuration: {
            baseURL: config.baseUrl,
        },
        // 如果需要更详细的 tracing，可以开启 verbose
        // verbose: process.env.NODE_ENV === "development",
    });
};
