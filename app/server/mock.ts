import { UserInfo } from '@/app/api/user';

export const mockUserInfo: UserInfo = {
  id: 'user-001',
  username: 'test_user',
  nickname: '测试用户',
  avatar: 'https://via.placeholder.com/150',
  email: 'test@example.com',
  role: 'user',
  createdAt: new Date().toISOString(),
  lastLoginAt: new Date().toISOString(),
  language: 'zh-CN',
};
