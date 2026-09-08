import { NextRequest, NextResponse } from 'next/server';
import { decodeSession, encodeSession, decodeGuestCookie, encodeGuestId, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/session';

const protectedPaths = ['/player', '/chat', '/setting', '/dashboard', '/profile'];

const GUEST_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

const isAuthenticated = (request: NextRequest): boolean => {
  const value = request.cookies.get(SESSION_COOKIE)?.value;
  return !!value && decodeSession(value) !== null;
};

const isGuest = (request: NextRequest): boolean => {
  const value = request.cookies.get('guest')?.value;
  // 仅承认签名合法且未过期的访客 Cookie；旧式 guest=1、裸 g_<uuid>、伪造/过期一律非访客。
  return !!value && decodeGuestCookie(value) !== null;
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
    // 访客滑动续签：仅对验签通过的身份以同一 gid 重签（刷新 30 天过期），非法身份不续签、不升级。
    const gid = rawGuest ? decodeGuestCookie(rawGuest) : null;
    if (gid) {
      try {
        response.cookies.set({
          name: 'guest',
          value: encodeGuestId(gid),
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/',
          maxAge: GUEST_COOKIE_MAX_AGE,
        });
      } catch {
        // 签名密钥缺失时不续签（失败闭环），保持原响应。
      }
    }
  }

  return response;
}

/**
 * 中间件匹配配置，排除静态与 API 资源。
 */
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
