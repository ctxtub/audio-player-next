import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';

import { fetchStory, summarizeStory } from '@/lib/server/storyUpstream';
import { ServiceError } from '@/lib/http/server/ErrorHandler';
import type { StoryApiRequest, StoryApiResponse, StoryMode } from '@/types/story';

type ErrorResponse = {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
};

const allowedModes: StoryMode[] = ['generate', 'continue'];

/**
 * 生成当前请求的唯一标识。
 */
const createRequestId = (): string => {
  if (typeof randomUUID === 'function') {
    return randomUUID();
  }

  return `story-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

/**
 * 统一处理布尔入参。
 * @param value 外部提供的布尔/字符串值。
 * @param fallback 默认布尔值。
 */
const normalizeBoolean = (value: unknown, fallback = false): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') {
      return true;
    }
    if (value.toLowerCase() === 'false') {
      return false;
    }
  }
  return fallback;
};

/**
 * 发送标准化的错误响应。
 */
const sendError = (
  status: number,
  code: string,
  message: string,
  requestId: string,
  upstreamRequestId?: string
) => {
  const headers: Record<string, string> = {
    'X-Request-Id': requestId,
    'Cache-Control': 'no-store',
  };

  if (upstreamRequestId) {
    headers['X-Upstream-Request-Id'] = upstreamRequestId;
  }

  return NextResponse.json<ErrorResponse>(
    {
      error: {
        code,
        message,
        requestId,
      },
    },
    { status, headers }
  );
};

/**
 * 处理故事生成/续写请求。
 * @param req Next.js Route Handler 的 Request 对象。
 * @returns 包含故事内容与摘要的响应。
 */
export const POST = async (req: Request) => {
  const requestId = createRequestId();

  let payload: StoryApiRequest;

  try {
    payload = (await req.json()) as StoryApiRequest;
  } catch (error) {
    return sendError(
      400,
      'INVALID_JSON',
      `请求体不是合法的 JSON: ${error instanceof Error ? error.message : '未知错误'}`,
      requestId
    );
  }

  const { mode, prompt, storyContent, withSummary } = payload ?? {};

  if (!mode || !allowedModes.includes(mode)) {
    return sendError(400, 'INVALID_REQUEST', 'mode 参数只能是 generate 或 continue', requestId);
  }

  if (typeof prompt !== 'string' || !prompt.trim()) {
    return sendError(400, 'INVALID_REQUEST', 'prompt 不能为空', requestId);
  }

  if (mode === 'continue' && (typeof storyContent !== 'string' || !storyContent.trim())) {
    return sendError(400, 'INVALID_REQUEST', '续写模式需要提供 storyContent', requestId);
  }

  const shouldSummarize =
    mode === 'continue' ? normalizeBoolean(withSummary, false) : false;

  try {
    let summary: string | null = null;

    if (mode === 'continue' && shouldSummarize && storyContent) {
      summary = await summarizeStory(storyContent, requestId);
    }

    const { story, usage } = await fetchStory({
      prompt,
      summarizedStory:
        mode === 'continue'
          ? summary ?? storyContent ?? ''
          : '',
      requestId,
    });

    const response: StoryApiResponse = {
      story,
      usage,
    };

    if (summary) {
      response.summary = summary;
    }

    return NextResponse.json<StoryApiResponse>(response, {
      status: 200,
      headers: {
        'X-Request-Id': requestId,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof ServiceError) {
      console.error('StoryServiceError', {
        message: error.message,
        status: error.status,
        code: error.code,
        details: error.details,
        requestId,
        upstreamRequestId: error.requestId,
        cause: error.cause,
      });

      return sendError(error.status, error.code, error.message, requestId, error.requestId);
    }

    console.error('Unhandled story API error', {
      error,
      requestId,
    });

    return sendError(
      500,
      'INTERNAL_SERVER_ERROR',
      '故事生成服务发生未知错误',
      requestId
    );
  }
};
