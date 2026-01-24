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
});

export type InteractInput = z.infer<typeof interactSchema>;
