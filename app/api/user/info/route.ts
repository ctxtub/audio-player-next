import { NextRequest } from 'next/server';
import { createSuccessResponse, createErrorResponse, authMiddleware } from '@/app/server';
import { mockUserInfo } from '@/app/server/mock';

// 模拟用户数据库
const usersDB = {
  'user-001': mockUserInfo
};

// GET 请求处理 - 获取用户信息
export async function GET(request: NextRequest) {
  // 身份验证
  const authResult = await authMiddleware(request);
  
  if ('error' in authResult) {
    return authResult;
  }
  
  try {
    const { userId } = authResult;
    
    // 从数据库获取用户信息
    const userInfo = usersDB[userId] || mockUserInfo;
    
    if (!userInfo) {
      return createErrorResponse('用户不存在', 404);
    }
    
    return createSuccessResponse(userInfo);
  } catch (error) {
    console.error('获取用户信息失败:', error);
    return createErrorResponse(
      error instanceof Error ? error.message : '获取用户信息失败',
      500
    );
  }
}

// PUT 请求处理 - 更新用户信息
export async function PUT(request: NextRequest) {
  // 身份验证
  const authResult = await authMiddleware(request);
  
  if ('error' in authResult) {
    return authResult;
  }
  
  try {
    const { userId } = authResult;
    const userData = await request.json();
    
    // 从数据库获取用户信息
    const userInfo = usersDB[userId];
    
    if (!userInfo) {
      return createErrorResponse('用户不存在', 404);
    }
    
    // 更新用户信息
    const updatedUser = {
      ...userInfo,
      ...userData,
      // 不允许更新的字段
      id: userInfo.id,
      createdAt: userInfo.createdAt
    };
    
    // 保存到数据库
    usersDB[userId] = updatedUser;
    
    return createSuccessResponse(updatedUser);
  } catch (error) {
    console.error('更新用户信息失败:', error);
    return createErrorResponse(
      error instanceof Error ? error.message : '更新用户信息失败',
      500
    );
  }
}
