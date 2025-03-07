// 模拟服务端接口响应
import { UserInfo } from '../api/user';

// 模拟用户数据
export const mockUserInfo: UserInfo = {
  id: 'user-001',
  username: 'test_user',
  nickname: '测试用户',
  avatar: 'https://via.placeholder.com/150',
  email: 'test@example.com',
  role: 'user',
  createdAt: new Date().toISOString(),
  lastLoginAt: new Date().toISOString(),
  preferences: {
    theme: 'dark',
    language: 'zh-CN',
    playDuration: 30,
  }
};

// 模拟API响应延迟
export const mockDelay = (ms: number = 300) => new Promise(resolve => setTimeout(resolve, ms));

// 模拟API响应
export const mockResponse = async <T>(data: T, error?: boolean, errorMessage?: string): Promise<T> => {
  await mockDelay();
  
  if (error) {
    throw new Error(errorMessage || '模拟API错误');
  }
  
  return data;
};
