import { NextRequest } from 'next/server';
import { createSuccessResponse, createErrorResponse } from '@/app/server';
import { mockUserInfo } from '@/app/server/mock';

// 模拟用户数据库
const usersDB = {
  'test_user': {
    id: 'user-001',
    username: 'test_user',
    password: 'password123', // 实际应用中应该存储加密后的密码
    userInfo: mockUserInfo
  }
};

// POST 请求处理 - 用户登录
export async function POST(request: NextRequest) {
  try {
    const { username, password } = await request.json();
    
    if (!username || !password) {
      return createErrorResponse('用户名和密码不能为空', 400);
    }
    
    // 查找用户
    const user = usersDB[username];
    
    if (!user || user.password !== password) {
      return createErrorResponse('用户名或密码错误', 401);
    }
    
    // 生成JWT令牌（这里简化处理，实际应该使用JWT库）
    const token = `mock-jwt-token-${Date.now()}`;
    
    // 更新用户最后登录时间
    const updatedUserInfo = {
      ...user.userInfo,
      lastLoginAt: new Date().toISOString()
    };
    
    // 返回用户信息和令牌
    return createSuccessResponse({
      token,
      user: updatedUserInfo
    });
  } catch (error) {
    console.error('登录失败:', error);
    return createErrorResponse(
      error instanceof Error ? error.message : '登录失败',
      500
    );
  }
}
