import axios, { AxiosError, AxiosInstance } from 'axios';
import { HttpError } from '@/lib/http/common/ErrorHandler';

type CreateHttpClientOptions = {
  baseURL?: string;
  timeout?: number;
  headers?: Record<string, string>;
  withCredentials?: boolean;
};

/**
 * 创建带统一错误处理的 axios 实例。
 */
export const createHttpClient = (options: CreateHttpClientOptions = {}): AxiosInstance => {
  const instance = axios.create({
    baseURL: options.baseURL,
    timeout: options.timeout ?? 60000,
    headers: options.headers,
    withCredentials: options.withCredentials ?? false,
  });

  instance.interceptors.response.use(
    (response) => response,
    (error: AxiosError) => {
      if (error.response) {
        const { status, data } = error.response;
        const payload =
          typeof data === 'object' && data !== null
            ? (data as { error?: { code?: string; message?: string } }).error
            : undefined;
        const message =
          payload?.message ||
          error.message ||
          `请求失败，状态码 ${status}`;

        throw new HttpError({
          status: typeof status === 'number' && status > 0 ? status : 500,
          code: payload?.code,
          message,
          details: data,
        });
      }

      if (error.request) {
        throw new HttpError({
          status: 0,
          code: 'NETWORK_ERROR',
          message: error.message || '网络请求失败',
          details: {
            request: error.request,
          },
        });
      }

      throw new HttpError({
        status: 0,
        code: 'UNKNOWN_ERROR',
        message: error.message || '未知错误',
        details: error,
      });
    }
  );

  return instance;
};
