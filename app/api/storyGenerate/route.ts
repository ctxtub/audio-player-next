import { NextResponse } from "next/server";
import type OpenAI from "openai";

import { ServiceError } from "@/lib/http/server/ErrorHandler";
import { invokeChatCompletion } from "@/lib/server/storyUpstream";
import type { StoryApiResponse, StoryContinueRequest, StoryGenerateRequest } from "@/types/story";

import { buildStoryMessages } from "./utils/buildStoryMessages";
import type { BuildStoryMessagesOptions } from "./utils/buildStoryMessages";

/**
 * BFF 层对请求体验证后的内部结构定义。
 */
type NormalizedStoryRequest =
  | (StoryGenerateRequest & { shouldSummarize?: false })
  | (StoryContinueRequest & { shouldSummarize: boolean });

/**
 * 统一构建错误响应的便捷函数。
 * @param status HTTP 状态码。
 * @param code 业务错误码。
 * @param message 错误描述。
 */
const buildErrorResponse = (status: number, code: string, message: string) =>
  NextResponse.json(
    {
      error: {
        code,
        message,
      },
    },
    { status },
  );

/**
 * 从 OpenAI 返回结果中提取文本内容。
 * @param completion OpenAI ChatCompletion 原始返回。
 */
const pickFirstChoiceText = (
  completion: OpenAI.Chat.Completions.ChatCompletion,
): string | null => {
  const firstChoice = completion.choices?.[0];
  const content = firstChoice?.message?.content;
  return typeof content === "string" && content.trim() ? content : null;
};

/**
 * 将原始 payload 解析为业务认可的请求结构。
 * @param payload 解析后的 JSON 对象。
 * @throws ServiceError 当入参非法时抛出。
 */
const normalizeRequest = (payload: unknown): NormalizedStoryRequest => {
  if (!payload || typeof payload !== "object") {
    throw new ServiceError({
      message: "请求体必须是对象",
      status: 400,
      code: "INVALID_REQUEST",
    });
  }

  const source = payload as Record<string, unknown>;
  const modeValue = typeof source.mode === "string" ? (source.mode as string) : undefined;
  const isGenerateMode = modeValue === "generate";
  const isContinueMode = modeValue === "continue";

  if (!isGenerateMode && !isContinueMode) {
    throw new ServiceError({
      message: "mode 参数只能是 generate 或 continue",
      status: 400,
      code: "INVALID_REQUEST",
    });
  }

  const prompt = typeof source.prompt === "string" ? source.prompt.trim() : "";
  if (!prompt) {
    throw new ServiceError({
      message: "prompt 不能为空",
      status: 400,
      code: "INVALID_REQUEST",
    });
  }

  if (isGenerateMode) {
    return {
      mode: "generate",
      prompt,
    };
  }

  const storyContent = typeof source.storyContent === "string" ? source.storyContent : "";
  if (!storyContent.trim()) {
    throw new ServiceError({
      message: "续写模式需要提供 storyContent",
      status: 400,
      code: "INVALID_REQUEST",
    });
  }

  const rawWithSummary = source.withSummary;
  let shouldSummarize = false;
  if (rawWithSummary !== undefined) {
    if (typeof rawWithSummary === "boolean") {
      shouldSummarize = rawWithSummary;
    } else if (typeof rawWithSummary === "string") {
      const normalized = rawWithSummary.trim().toLowerCase();
      if (normalized === "true" || normalized === "1") {
        shouldSummarize = true;
      } else if (normalized === "false" || normalized === "0") {
        shouldSummarize = false;
      } else {
        throw new ServiceError({
          message: "withSummary 只能是布尔值", 
          status: 400,
          code: "INVALID_REQUEST",
        });
      }
    } else {
      throw new ServiceError({
        message: "withSummary 只能是布尔值",
        status: 400,
        code: "INVALID_REQUEST",
      });
    }
  }

  return {
    mode: "continue",
    prompt,
    storyContent,
    withSummary: shouldSummarize,
    shouldSummarize,
  };
};

/**
 * 调用 OpenAI 并解析故事文本。
 * @param messageOptions 构造消息所需的配置。
 */
const requestStoryContent = async (
  messageOptions: BuildStoryMessagesOptions,
): Promise<string> => {
  const messages = buildStoryMessages(messageOptions);
  const completion = await invokeChatCompletion(messages);
  const story = pickFirstChoiceText(completion);

  if (!story) {
    throw new ServiceError({
      message: "OpenAI 返回的故事内容为空",
      status: 502,
      code: "UPSTREAM_BAD_RESPONSE",
      details: {
        choices: completion.choices,
      },
    });
  }

  return story;
};

/**
 * 处理故事生成/续写请求。
 * @param req Next.js Route Handler 的 Request 对象。
 * @returns 包含故事内容与摘要的响应。
 */
export const POST = async (req: Request) => {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch (error) {
    return buildErrorResponse(
      400,
      "INVALID_JSON",
      `请求体不是合法的 JSON: ${error instanceof Error ? error.message : "未知错误"}`,
    );
  }

  let normalized: NormalizedStoryRequest;
  try {
    normalized = normalizeRequest(payload);
  } catch (error) {
    if (error instanceof ServiceError) {
      return buildErrorResponse(error.status, error.code, error.message);
    }

    return buildErrorResponse(500, "INTERNAL_SERVER_ERROR", "故事生成服务发生未知错误");
  }

  try {
    if (normalized.mode === "generate") {
      const storyContent = await requestStoryContent({
        mode: "generate",
        prompt: normalized.prompt,
      });

      return NextResponse.json<StoryApiResponse>(
        { storyContent },
        {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    }

    let summary: string | null = null;
    if (normalized.shouldSummarize) {
      summary = await requestStoryContent({
        mode: "continue",
        prompt: normalized.prompt,
        storyContent: normalized.storyContent,
        summaryMode: true,
      });
    }

    const context = summary ?? normalized.storyContent;
    const storyContent = await requestStoryContent({
      mode: "continue",
      prompt: normalized.prompt,
      storyContent: context,
    });

    const response: StoryApiResponse = {
      storyContent,
    };

    if (summary) {
      response.summaryContent = summary;
    }

    return NextResponse.json<StoryApiResponse>(response, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ServiceError) {
      return buildErrorResponse(error.status, error.code, error.message);
    }

    return buildErrorResponse(500, "INTERNAL_SERVER_ERROR", "故事生成服务发生未知错误");
  }
};
