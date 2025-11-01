import type { AppConfigResponse } from '@/types/appConfig';
import { browserHttp } from '@/lib/http/browser';
import { HttpError } from '@/lib/http/common/ErrorHandler';

/**
 * 前端配置 API 客户端错误类型。
 */
export class AppConfigClientError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'AppConfigClientError';
    this.status = status;
    this.code = code;
  }
}

/**
 * 请求应用运行时配置。
 * @returns 服务端返回的配置对象。
 * @throws AppConfigClientError
 */
export const fetchAppConfig = async (): Promise<AppConfigResponse> => {
  try {
    const response = await browserHttp.get<AppConfigResponse>('/api/appConfig', {
      headers: {
        Accept: 'application/json',
      },
    });
    return response.data as AppConfigResponse;
  } catch (error) {
    if (error instanceof AppConfigClientError) {
      throw error;
    }

    if (error instanceof HttpError) {
      throw new AppConfigClientError(
        error.message,
        error.status,
        error.code || 'APP_CONFIG_API_ERROR'
      );
    }

    throw new AppConfigClientError(
      error instanceof Error ? error.message : '网络错误',
      0,
      'NETWORK_ERROR'
    );
  }
};
