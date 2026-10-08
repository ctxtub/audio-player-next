'use client';
import { useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useChatStore } from '@/stores/chatStore';
/** 登录内的列表位置与查询上下文；登出自动清空。 */
const positions = new Map<string, number>();
/** 最近浏览的故事库列表地址。 */
let lastList = '/library';
/** 显式返回父级时保留最近的列表筛选。 */
export function libraryReturnPath(): string { return lastList; }
/** 跨路由保留列表滚动，不控制播放或创作身份。 */
export function LibraryNavigationMemory() {
  const pathname = usePathname();
  const params = useSearchParams();
  const key = `${pathname}${params?.size ? `?${params}` : ''}`;
  useEffect(() => {
    const unsubscribe = useChatStore.subscribe((state, previous) => {
      if (previous.syncEnabled && !state.syncEnabled) { positions.clear(); lastList = '/library'; }
    });
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (!['/library', '/library/favorites', '/library/trash'].includes(pathname)) return;
    lastList = key;
    const container = document.querySelector<HTMLElement>('[data-testid="main-chrome-content"]');
    const target = positions.get(key) ?? 0;
    const observer = new ResizeObserver(() => { if (container && target > 0) container.scrollTop = target; });
    if (container) { container.scrollTop = target; const content = container.firstElementChild; if (content) observer.observe(content); }
    const remember = () => { if (container) positions.set(key, container.scrollTop); observer.disconnect(); };
    container?.addEventListener('scroll', remember, { passive: true });
    return () => { remember(); container?.removeEventListener('scroll', remember); observer.disconnect(); };
  }, [key, pathname]);
  return null;
}
