import { NextRequest } from 'next/server';
import { createSuccessResponse, createErrorResponse } from '@/app/server';
import { mockUserInfo } from '@/app/server/mock';

// 模拟用户数据库
type UserRecord = {
  id: string;
  username: string;
  password: string;
  userInfo: typeof mockUserInfo;
};

const usersDB: Record<string, UserRecord> = {
  'test_user': {
    id: 'user-001',
    username: 'test_user',
    password: 'password123', // 实际应用中应该存储加密后的密码
    userInfo: mockUserInfo
  }
};

// POST 请求处理 - 用户注册
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<{
      username: string;
      password: string;
      email: string;
    }>;
    const username = body.username ?? '';
    const password = body.password ?? '';
    const email = body.email ?? '';
    
    if (!username || !password || !email) {
      return createErrorResponse('用户名、密码和邮箱不能为空', 400);
    }
    
    // 检查用户名是否已存在
    if (usersDB[username]) {
      return createErrorResponse('用户名已存在', 409);
    }
    
    // 创建新用户ID
    const userId = `user-${Date.now()}`;
    
    // 创建新用户信息
    const newUserInfo = {
      id: userId,
      username,
      nickname: username,
      email,
      role: 'user' as const,
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
      language: 'zh-CN'
    };
    
    // 保存到数据库
    usersDB[username] = {
      id: userId,
      username,
      password, // 实际应用中应该加密存储
      userInfo: newUserInfo
    };
    
    return createSuccessResponse(newUserInfo);
  } catch (error) {
    console.error('注册失败:', error);
    return createErrorResponse(
      error instanceof Error ? error.message : '注册失败',
      500
    );
  }
}
