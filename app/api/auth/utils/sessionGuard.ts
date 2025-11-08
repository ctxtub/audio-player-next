import { cookies } from 'next/headers';

import { ServiceError } from '@/lib/http/server/ErrorHandler';
import { getAuthCookieName } from '@/utils/authCookie';
import type { AuthSession } from '@/types/auth';

/**
 * 统一解析 Cookie 中登录态的工具函数。
 * @returns 登录成功时返回会话信息，未登录时返回 null。
 */
export const readAuthSession = async (): Promise<AuthSession | null> => {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(getAuthCookieName());
  const nickname = sessionCookie?.value ? decodeURIComponent(sessionCookie.value) : '';

  if (!nickname) {
    return null;
  }

  return { nickname };
};

/**
 * 统一的登录鉴权拦截器，确保调用者必须登录。
 * @returns 登录态会话信息。
 * @throws ServiceError 当用户未登录或会话已失效时抛出。
 */
export const requireAuthSession = async (): Promise<AuthSession> => {
  const session = await readAuthSession();

  if (!session) {
    throw new ServiceError({
      message: '用户未登录或会话已失效',
      status: 401,
      code: 'UNAUTHORIZED',
    });
  }

  return session;
};
