import { NextRequest, NextResponse } from 'next/server';
import { decodeSession, encodeSession, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/session';

const protectedPaths = ['/player', '/chat', '/setting', '/dashboard', '/profile'];

const GUEST_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

const isAuthenticated = (request: NextRequest): boolean => {
  const value = request.cookies.get(SESSION_COOKIE)?.value;
  return !!value && decodeSession(value) !== null;
};

const isGuest = (request: NextRequest): boolean => {
  const value = request.cookies.get('guest')?.value;
  return !!value && (value.startsWith('g_') || value === '1');
};

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const sessionValue = request.cookies.get(SESSION_COOKIE)?.value;
  const session = sessionValue ? decodeSession(sessionValue) : null;
  const authed = !!session;
  const rawGuest = request.cookies.get('guest')?.value;
  const guest = isGuest(request);

  // 已登录访问 /auth → 反向守卫，跳回首页
  if (path.startsWith('/auth') && authed) {
    return NextResponse.redirect(new URL('/chat', request.url));
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
  } else if (guest) {
    // 访客模式：若为旧版 guest=1 则升级为 g_<uuid>；若已有 g_<uuid> 则 30 天滑动续签
    const guestId = (rawGuest && rawGuest.startsWith('g_'))
      ? rawGuest
      : `g_${crypto.randomUUID()}`;

    response.cookies.set({
      name: 'guest',
      value: guestId,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: GUEST_COOKIE_MAX_AGE,
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
