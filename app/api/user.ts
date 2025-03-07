// 用户信息接口
export interface UserInfo {
  id: string;
  username: string;
  nickname?: string;
  avatar?: string;
  email?: string;
  role: 'user' | 'admin';
  createdAt: string;
  lastLoginAt: string;
  preferences?: {
    theme?: 'light' | 'dark';
    language?: string;
    playDuration?: number;
  };
}

// API响应接口
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: number;
}

// 通用API请求方法
async function apiRequest<T>(
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  data?: any
): Promise<T> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };
  
  const options: RequestInit = {
    method,
    headers,
    credentials: 'include',
  };
  
  if (data && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(data);
  }
  
  const response = await fetch(`/api${endpoint}`, options);
  const result = await response.json() as ApiResponse<T>;
  
  if (!result.success) {
    throw new Error(result.error || `请求失败: ${response.status}`);
  }
  
  return result.data as T;
}

// 获取当前登录用户信息
export const fetchUserInfo = async (): Promise<UserInfo> => {
  return apiRequest<UserInfo>('/user/info');
};

// 更新用户信息
export const updateUserInfo = async (userInfo: Partial<UserInfo>): Promise<UserInfo> => {
  return apiRequest<UserInfo>('/user/info', 'PUT', userInfo);
};

// 更新用户偏好设置
export const updateUserPreferences = async (preferences: UserInfo['preferences']): Promise<UserInfo> => {
  return apiRequest<UserInfo>('/user/preferences', 'PUT', { preferences });
};

// 用户登录
export const login = async (username: string, password: string): Promise<{ token: string; user: UserInfo }> => {
  return apiRequest<{ token: string; user: UserInfo }>('/auth/login', 'POST', { username, password });
};

// 用户注册
export const register = async (username: string, password: string, email: string): Promise<UserInfo> => {
  return apiRequest<UserInfo>('/auth/register', 'POST', { username, password, email });
};

// 用户登出
export const logout = async (): Promise<{ success: boolean }> => {
  return apiRequest<{ success: boolean }>('/auth/logout', 'POST');
};
