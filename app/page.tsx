import { redirect } from 'next/navigation';

/**
 * 根路径重定向到首页。
 */
export default function RootPage() {
  redirect('/chat');
}
