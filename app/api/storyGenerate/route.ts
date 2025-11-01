import { NextResponse } from 'next/server';

import { handleStoryRequest } from '@/lib/server/storyUpstream';
import { ServiceError } from '@/lib/http/server/ErrorHandler';
import type { StoryApiResponse } from '@/types/story';

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
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_JSON',
          message: `请求体不是合法的 JSON: ${
            error instanceof Error ? error.message : '未知错误'
          }`,
        },
      },
      { status: 400 },
    );
  }

  try {
    const response: StoryApiResponse = await handleStoryRequest(payload);
    return NextResponse.json<StoryApiResponse>(response, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof ServiceError) {
      return NextResponse.json(
        {
          error: {
            code: error.code,
            message: error.message,
          },
        },
        { status: error.status },
      );
    }

    return NextResponse.json(
      {
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: '故事生成服务发生未知错误',
        },
      },
      { status: 500 },
    );
  }
};
