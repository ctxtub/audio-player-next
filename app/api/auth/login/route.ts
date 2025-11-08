import { NextResponse } from 'next/server';

import { ServiceError } from '@/lib/http/server/ErrorHandler';
import { buildAuthCookie } from '@/utils/authCookie';
import type {
  AuthErrorResponse,
  AuthLoginRequest,
  AuthLoginSuccessResponse,
} from '@/types/auth';

import { AUTHORIZED_USER_WHITELIST } from '../authorizedUsers';

/**
 * 构建统一的错误响应。
 * @param status HTTP 状态码。
 * @param code 业务错误码。
 * @param message 错误提示文案。
 */
const buildErrorResponse = (
  status: number,
  code: string,
  message: string
) =>
  NextResponse.json<AuthErrorResponse>(
    {
      success: false,
      error: {
        code,
        message,
      },
    },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );

/**
 * 校验并归一化登录请求参数。
 * @param payload 待解析的原始请求体。
 * @returns 合法的登录请求。
 */
const normalizePayload = (payload: unknown): AuthLoginRequest => {
  if (!payload || typeof payload !== 'object') {
    throw new ServiceError({
      message: '请求体必须是对象',
      status: 400,
      code: 'INVALID_REQUEST',
    });
  }

  const source = payload as Record<string, unknown>;
  const username = typeof source.username === 'string' ? source.username.trim() : '';
  const password = typeof source.password === 'string' ? source.password.trim() : '';

  if (!username || !password) {
    throw new ServiceError({
      message: '账号和密码均不能为空',
      status: 400,
      code: 'INVALID_REQUEST',
    });
  }

  return { username, password };
};

/**
 * 校验账号与密码是否正确。
 * @param payload 归一化后的请求体。
 */
const verifyCredential = (payload: AuthLoginRequest) => {
  const expectedPassword = AUTHORIZED_USER_WHITELIST[payload.username];
  if (!expectedPassword || payload.password !== expectedPassword) {
    throw new ServiceError({
      message: '账号或密码错误',
      status: 401,
      code: 'INVALID_CREDENTIAL',
    });
  }
};

/**
 * 处理登录请求，成功时写入 Cookie。
 * @param req Next.js 路由请求对象。
 * @returns 登录成功或失败的响应。
 */
export const POST = async (req: Request) => {
  let payload: unknown;

  try {
    payload = await req.json();
  } catch (error) {
    return buildErrorResponse(
      400,
      'INVALID_JSON',
      `请求体不是合法的 JSON: ${error instanceof Error ? error.message : '未知错误'}`
    );
  }

  let normalized: AuthLoginRequest;
  try {
    normalized = normalizePayload(payload);
    verifyCredential(normalized);
  } catch (error) {
    if (error instanceof ServiceError) {
      return buildErrorResponse(error.status, error.code, error.message);
    }

    return buildErrorResponse(500, 'INTERNAL_SERVER_ERROR', '登录服务发生未知错误');
  }

  const responseBody: AuthLoginSuccessResponse = {
    success: true,
    user: {
      nickname: normalized.username,
    },
  };

  return NextResponse.json<AuthLoginSuccessResponse>(responseBody, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Set-Cookie': buildAuthCookie(normalized.username),
    },
  });
};
