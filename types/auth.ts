/**
 * 登录请求的入参结构。
 */
export interface AuthLoginRequest {
  username: string;
  password: string;
}

/**
 * 登录成功后的响应结构。
 */
export interface AuthLoginSuccessResponse {
  success: true;
  user: {
    nickname: string;
  };
}

/**
 * 登录或登出失败时的响应结构。
 */
export interface AuthErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

/**
 * 登出接口的响应结构。
 */
export interface AuthLogoutResponse {
  success: true;
}

/**
 * 查询当前登录态时的响应结构。
 */
export interface AuthProfileResponse {
  isLogin: boolean;
  user?: {
    nickname: string;
  };
}

/**
 * 登录态 Cookie 解析后的会话信息。
 */
export interface AuthSession {
  userId: number;
  nickname: string;
}
