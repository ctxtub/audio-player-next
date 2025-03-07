import { NextRequest } from 'next/server';
import { createSuccessResponse, createErrorResponse, authMiddleware } from '@/app/server';
import { mockUserInfo } from '@/app/server/mock';

// 模拟用户数据库
const usersDB = {
  'user-001': mockUserInfo
};

// PUT 请求处理 - 更新用户偏好设置
export async function PUT(request: NextRequest) {
  // 身份验证
  const authResult = await authMiddleware(request);
  
  if ('error' in authResult) {
    return authResult;
  }
  
  try {
    const { userId } = authResult;
    const { preferences } = await request.json();
    
    // 从数据库获取用户信息
    const userInfo = usersDB[userId];
    
    if (!userInfo) {
      return createErrorResponse('用户不存在', 404);
    }
    
    // 更新用户偏好设置
    const updatedUser = {
      ...userInfo,
      preferences: {
        ...userInfo.preferences,
        ...preferences
      }
    };
    
    // 保存到数据库
    usersDB[userId] = updatedUser;
    
    return createSuccessResponse(updatedUser);
  } catch (error) {
    console.error('更新用户偏好设置失败:', error);
    return createErrorResponse(
      error instanceof Error ? error.message : '更新用户偏好设置失败',
      500
    );
  }
}
