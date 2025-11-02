import { NextResponse } from 'next/server';

import { loadTtsConfig } from '@/lib/server/ttsUpstream/config';
import { ServiceError } from '@/lib/http/server/ErrorHandler';
import type { AppConfigResponse } from '@/types/appConfig';

/**
 * 默认播放时长（分钟），用于缺省配置。
 */
const DEFAULT_PLAY_DURATION = 30;

/**
 * 返回应用运行时配置（例如语音白名单、默认播放设置）。
 */
export const GET = async () => {
  try {
    const { voicesList, voiceId } = loadTtsConfig();

    const payload: AppConfigResponse = {
      voicesList,
      voiceId,
      playDuration: DEFAULT_PLAY_DURATION,
    };

    return NextResponse.json<AppConfigResponse>(payload, {
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
        { status: error.status }
      );
    }

    return NextResponse.json(
      {
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: '获取应用配置时发生未知错误',
        },
      },
      { status: 500 }
    );
  }
};
