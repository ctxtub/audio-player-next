import { NextRequest, NextResponse } from 'next/server';
import { decodeSession, encodeSession, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/session';

const protectedPaths = ['/home', '/chat', '/setting', '/dashboard', '/profile'];

const isAuthenticated = (request: NextRequest): boolean => {
  const value = request.cookies.get(SESSION_COOKIE)?.value;
  return !!value && decodeSession(value) !== null;
};

const isGuest = (request: NextRequest): boolean => {
  return request.cookies.get('guest')?.value === '1';
};

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const sessionValue = request.cookies.get(SESSION_COOKIE)?.value;
  const session = sessionValue ? decodeSession(sessionValue) : null;
  const authed = !!session;
  const guest = isGuest(request);

  // 已登录访问 /auth → 反向守卫，跳回首页
  if (path.startsWith('/auth') && authed) {
    return NextResponse.redirect(new URL('/home', request.url));
  }

  // 受保护路径：已登录或访客均可访问，未认证则跳转到 /auth
  if (protectedPaths.some(p => path.startsWith(p))) {
    if (!authed && !guest) {
      const authUrl = new URL('/auth', request.url);
      authUrl.searchParams.set('from', path);
      return NextResponse.redirect(authUrl);
    }
  }

  const response = NextResponse.next();

  // 已登录用户：每次页面请求自动续签 Session Cookie，防止活跃用户意外登出
  if (session) {
    response.cookies.set({
      name: SESSION_COOKIE,
      value: encodeSession(session.userId, session.nickname),
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE,
    });
  }

  return response;
}

/**
 * 中间件匹配配置，排除静态与 API 资源。
 */
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
