// 服务端接口的入口文件
import { NextRequest, NextResponse } from 'next/server';

// 定义API响应格式
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: number;
}

// 创建成功响应
export function createSuccessResponse<T>(data: T): NextResponse<ApiResponse<T>> {
  return NextResponse.json({
    success: true,
    data
  });
}

// 创建错误响应
export function createErrorResponse(message: string, code: number = 400): NextResponse<ApiResponse<null>> {
  return NextResponse.json({
    success: false,
    error: message,
    code
  }, { status: code });
}

// 身份验证中间件
export async function authMiddleware(request: NextRequest) {
  // 从请求头或cookie中获取token
  const token = request.headers.get('Authorization')?.replace('Bearer ', '') || 
                request.cookies.get('auth_token')?.value;
  
  if (!token) {
    return createErrorResponse('未授权访问', 401);
  }
  
  try {
    // 这里应该验证token的有效性，例如使用JWT验证
    // 简化版本，仅作示例
    if (token === 'invalid') {
      throw new Error('无效的令牌');
    }
    
    // 模拟获取用户信息
    const userId = 'user-001'; // 实际应从token中解析
    
    // 返回用户ID，可以在后续处理中使用
    return { userId };
  } catch (error) {
    return createErrorResponse(
      error instanceof Error ? error.message : '身份验证失败', 
      401
    );
  }
}
