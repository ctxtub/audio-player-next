import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';

import { DEFAULT_API_CONFIG } from '@/app/config/home';
import { loadTtsConfig } from '@/lib/server/ttsUpstream/config';
import { ServiceError } from '@/lib/http/server/ErrorHandler';
import type { AppConfigResponse, AppConfigError } from '@/types/config';

const createRequestId = (): string => {
  if (typeof randomUUID === 'function') {
    return randomUUID();
  }
  return `config-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

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

  return NextResponse.json<AppConfigError>(
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
 * 返回应用运行时配置（例如语音白名单、默认播放设置）。
 */
export const GET = async () => {
  const requestId = createRequestId();

  try {
    const { voices, defaultVoice } = loadTtsConfig();

    const payload: AppConfigResponse = {
      tts: {
        voices,
        defaultVoice,
      },
      defaults: {
        playDuration: DEFAULT_API_CONFIG.playDuration,
        voiceName: defaultVoice || DEFAULT_API_CONFIG.voiceName,
      },
    };

    return NextResponse.json<AppConfigResponse>(payload, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'X-Request-Id': requestId,
      },
    });
  } catch (error) {
    if (error instanceof ServiceError) {
      console.error('AppConfig TtsServiceError', {
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

    console.error('AppConfig unexpected error', { error, requestId });
    return sendError(
      500,
      'INTERNAL_SERVER_ERROR',
      '获取应用配置时发生未知错误',
      requestId
    );
  }
};
