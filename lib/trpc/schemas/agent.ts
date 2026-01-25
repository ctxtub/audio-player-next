import { z } from "zod";

/**
 * Agent 交互的输入校验 Schema。
 * 遵循 OpenAI 风格的消息格式。
 */
export const interactSchema = z.object({
    messages: z.array(
        z.object({
            role: z.enum(["user", "assistant", "system"]),
            content: z.string(),
        })
    ),
    /**
     * Agent 配置参数，支持按命名空间扩展。
     */
    agentConfig: z
        .object({
            audio: z
                .object({
                    speed: z.number().optional(),
                    voiceId: z.string().optional(),
                })
                .optional(),
        })
        .and(z.record(z.string(), z.any()))
        .optional(),
});

export const summarizeContextSchema = z.object({
    messages: z.array(
        z.object({
            role: z.enum(["user", "assistant", "system"]),
            content: z.string(),
        })
    ),
});

export type InteractInput = z.infer<typeof interactSchema>;
export type SummarizeContextInput = z.infer<typeof summarizeContextSchema>;
