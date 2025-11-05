import { NextResponse } from "next/server";

import { handleTtsRequest } from "@/lib/server/ttsUpstream";
import { ServiceError } from "@/lib/http/server/ErrorHandler";

/**
 * 处理语音合成请求。
 * @param req Next.js 请求对象。
 * @returns 包含音频流的 Response。
 */
export const POST = async (req: Request) => {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_JSON",
          message: `请求体不是合法的 JSON: ${
            error instanceof Error ? error.message : "未知错误"
          }`,
        },
      },
      { status: 400 },
    );
  }

  try {
    const { audio } = await handleTtsRequest(payload);

    const buffer = Buffer.from(audio);

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
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
          code: "INTERNAL_SERVER_ERROR",
          message: "语音合成服务发生未知错误",
        },
      },
      { status: 500 },
    );
  }
};
