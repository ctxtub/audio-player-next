import { NextResponse } from 'next/server';

import type { AuthProfileResponse } from '@/types/auth';

import { readAuthSession } from '../utils/sessionGuard';

/**
 * 处理登录态查询请求。
 * @returns 包含登录状态的响应。
 */
export const GET = async () => {
  const session = await readAuthSession();

  const responseBody: AuthProfileResponse = session
    ? {
        isLogin: true,
        user: {
          nickname: session.nickname,
        },
      }
    : {
        isLogin: false,
      };

  return NextResponse.json<AuthProfileResponse>(responseBody, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
    },
  });
};
