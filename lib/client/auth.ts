import { browserHttp } from '@/lib/http/browser';
import { HttpError } from '@/lib/http/common/ErrorHandler';
import type {
  AuthLoginRequest,
  AuthLoginSuccessResponse,
  AuthLogoutResponse,
  AuthProfileResponse,
} from '@/types/auth';

/**
 * 登录接口调用失败时抛出的错误类型。
 */
export class AuthClientError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'AuthClientError';
    this.status = status;
    this.code = code;
  }
}

/**
 * 请求登录接口。
 * @param payload 登录请求参数。
 * @returns 登录成功后的结果。
 */
export const login = async (payload: AuthLoginRequest): Promise<AuthLoginSuccessResponse> => {
  try {
    const response = await browserHttp.post<AuthLoginSuccessResponse>('/api/auth/login', payload, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const data = response.data;
    if (!data || data.success !== true || !data.user?.nickname) {
      throw new AuthClientError('登录响应格式不正确', 502, 'AUTH_INVALID_RESPONSE');
    }

    return data;
  } catch (error) {
    if (error instanceof AuthClientError) {
      throw error;
    }

    if (error instanceof HttpError) {
      throw new AuthClientError(
        error.message,
        error.status,
        error.code || 'AUTH_REQUEST_FAILED'
      );
    }

    throw new AuthClientError(error instanceof Error ? error.message : '登录失败', 0, 'UNKNOWN_ERROR');
  }
};

/**
 * 请求登出接口。
 */
export const logout = async (): Promise<void> => {
  try {
    const response = await browserHttp.post<AuthLogoutResponse>('/api/auth/logout');
    const data = response.data;

    if (!data || data.success !== true) {
      throw new AuthClientError('登出响应格式不正确', 502, 'AUTH_INVALID_RESPONSE');
    }
  } catch (error) {
    if (error instanceof AuthClientError) {
      throw error;
    }

    if (error instanceof HttpError) {
      throw new AuthClientError(
        error.message,
        error.status,
        error.code || 'AUTH_REQUEST_FAILED'
      );
    }

    throw new AuthClientError(error instanceof Error ? error.message : '登出失败', 0, 'UNKNOWN_ERROR');
  }
};

/**
 * 查询当前登录态信息。
 * @returns 登录态响应结果。
 */
export const fetchProfile = async (): Promise<AuthProfileResponse> => {
  try {
    const response = await browserHttp.get<AuthProfileResponse>('/api/auth/profile');
    const data = response.data;

    if (!data || typeof data.isLogin !== 'boolean') {
      throw new AuthClientError('登录态响应格式不正确', 502, 'AUTH_INVALID_RESPONSE');
    }

    return data;
  } catch (error) {
    if (error instanceof AuthClientError) {
      throw error;
    }

    if (error instanceof HttpError) {
      throw new AuthClientError(
        error.message,
        error.status,
        error.code || 'AUTH_REQUEST_FAILED'
      );
    }

    throw new AuthClientError(error instanceof Error ? error.message : '获取登录态失败', 0, 'UNKNOWN_ERROR');
  }
};
