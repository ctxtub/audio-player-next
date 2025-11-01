import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';

import { synthesizeSpeech } from '@/lib/server/ttsUpstream';
import { ServiceError } from '@/lib/http/server/ErrorHandler';
import type { TtsApiError, TtsApiRequest } from '@/types/tts';

type ErrorResponse = TtsApiError;

/**
 * 生成 TTS 请求的唯一标识。
 */
const createRequestId = (): string => {
  if (typeof randomUUID === 'function') {
    return randomUUID();
  }
  return `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

/**
 * 返回标准化的错误响应。
 */
const sendError = (
  status: number,
  code: string,
  message: string,
  requestId: string,
  upstreamRequestId?: string
) => {
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'X-Request-Id': requestId,
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
 * 处理语音合成请求。
 * @param req Next.js 请求对象。
 * @returns 包含音频流的 Response。
 */
export const POST = async (req: Request) => {
  const requestId = createRequestId();

  let payload: TtsApiRequest;
  try {
    payload = (await req.json()) as TtsApiRequest;
  } catch (error) {
    return sendError(
      400,
      'INVALID_JSON',
      `请求体不是合法的 JSON: ${error instanceof Error ? error.message : '未知错误'}`,
      requestId
    );
  }

  const text = typeof payload?.text === 'string' ? payload.text : '';
  const requestedVoice = typeof payload?.voiceName === 'string' ? payload.voiceName : undefined;

  if (!text.trim()) {
    return sendError(400, 'INVALID_REQUEST', 'text 不能为空', requestId);
  }

  try {
    const { audio, voiceName } = await synthesizeSpeech({
      text,
      voiceName: requestedVoice,
      requestId,
    });

    const buffer = Buffer.from(audio);

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        'X-Request-Id': requestId,
        'X-Voice-Name': voiceName,
      },
    });
  } catch (error) {
    if (error instanceof ServiceError) {
      console.error('TtsServiceError', {
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

    console.error('Unhandled TTS error', { error, requestId });
    return sendError(
      500,
      'INTERNAL_SERVER_ERROR',
      '语音合成服务发生未知错误',
      requestId
    );
  }
};
