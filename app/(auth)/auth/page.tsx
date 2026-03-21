import { Suspense } from 'react';
import AuthPage from './index';

/** 路由入口：包裹 Suspense 以满足 useSearchParams 的 SSG 要求 */
export default function AuthPageEntry() {
  return (
    <Suspense>
      <AuthPage />
    </Suspense>
  );
}
