import { NextResponse } from 'next/server';

import { clearAuthCookie } from '@/utils/authCookie';
import type { AuthLogoutResponse } from '@/types/auth';

/**
 * 处理登出请求，清空登录态 Cookie。
 * @returns 登出结果响应。
 */
export const POST = async () => {
  const responseBody: AuthLogoutResponse = {
    success: true,
  };

  return NextResponse.json<AuthLogoutResponse>(responseBody, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Set-Cookie': clearAuthCookie(),
    },
  });
};
