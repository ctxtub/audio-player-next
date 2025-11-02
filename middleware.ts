import { NextRequest, NextResponse } from 'next/server';
import { authMiddleware } from '@/app/server';

/**
 * 需要进行身份校验的受保护路径前缀。
 */
const protectedPaths = ['/dashboard', '/profile', '/settings'];

/**
 * 应用中间件，在访问受保护路径时执行身份校验。
 * @param request 当前请求对象
 * @returns 认证通过返回原请求，失败则重定向到登录页
 */
export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (protectedPaths.some((prefix) => path.startsWith(prefix))) {
    const authResult = await authMiddleware(request);

    if ('error' in authResult) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('from', path);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

/**
 * 中间件匹配配置，排除静态与 API 资源。
 */
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
