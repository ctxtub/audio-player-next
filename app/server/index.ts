import { NextRequest, NextResponse } from 'next/server';

/**
 * 定义 API 响应的统一数据结构。
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: number;
}

/**
 * 构造错误响应，统一输出错误信息与状态码。
 * @param message 错误描述
 * @param code HTTP 状态码，默认 400
 * @returns Next.js JSON 响应对象
 */
export function createErrorResponse(
  message: string,
  code: number = 400
): NextResponse<ApiResponse<null>> {
  return NextResponse.json(
    {
      success: false,
      error: message,
      code,
    },
    { status: code }
  );
}

/**
 * 简化版身份验证中间件，用于示例受保护接口。
 * @param request 需要认证的请求对象
 * @returns 验证成功时返回用户标识，失败时返回错误响应
 */
export async function authMiddleware(request: NextRequest) {
  const token =
    request.headers.get('Authorization')?.replace('Bearer ', '') ||
    request.cookies.get('auth_token')?.value;

  if (!token) {
    return createErrorResponse('未授权访问', 401);
  }

  try {
    if (token === 'invalid') {
      throw new Error('无效的令牌');
    }

    const userId = 'user-001';

    return { userId };
  } catch (error) {
    return createErrorResponse(
      error instanceof Error ? error.message : '身份验证失败',
      401
    );
  }
}
