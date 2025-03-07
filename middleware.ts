import { NextRequest, NextResponse } from 'next/server';
import { authMiddleware } from './app/server';

// 定义需要保护的路径
const protectedPaths = ['/dashboard', '/profile', '/settings'];

const applyClientHintHeaders = (response: NextResponse) => {
  response.headers.set('Accept-CH', 'Sec-CH-Prefers-Color-Scheme');
  response.headers.set('Critical-CH', 'Sec-CH-Prefers-Color-Scheme');
  response.headers.set('Permissions-Policy', 'ch-prefers-color-scheme=(self)');
  return response;
};

export async function middleware(request: NextRequest) {
  // 检查是否是受保护的路径
  const path = request.nextUrl.pathname;
  if (protectedPaths.some(prefix => path.startsWith(prefix))) {
    // 调用认证中间件
    const authResult = await authMiddleware(request);
    
    // 如果认证失败，重定向到登录页面
    if ('error' in authResult) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('from', path);
      return applyClientHintHeaders(NextResponse.redirect(loginUrl));
    }
  }
  
  return applyClientHintHeaders(NextResponse.next());
}

// 配置匹配的路径
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
