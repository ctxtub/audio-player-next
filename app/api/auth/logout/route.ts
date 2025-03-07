import { NextRequest } from 'next/server';
import { createSuccessResponse, createErrorResponse, authMiddleware } from '@/app/server';

// POST 请求处理 - 用户登出
export async function POST(request: NextRequest) {
  // 身份验证
  const authResult = await authMiddleware(request);
  
  if ('error' in authResult) {
    return authResult;
  }
  
  try {
    // 实际应用中，这里应该使令牌失效或清除会话
    // 简化处理，直接返回成功
    return createSuccessResponse({ success: true });
  } catch (error) {
    console.error('登出失败:', error);
    return createErrorResponse(
      error instanceof Error ? error.message : '登出失败',
      500
    );
  }
}
