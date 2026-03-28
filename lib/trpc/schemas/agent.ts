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
                    speed: z.number().min(0.25).max(4.0).optional(),
                    voiceId: z.string().min(1).optional(),
                })
                .optional(),
        })
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
