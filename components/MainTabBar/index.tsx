'use client';

import React, { useCallback, useEffect } from 'react';
import { MessageCircle, LibraryBig, Settings } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useChatStore } from '@/stores/chatStore';
import {
  MAIN_TABS,
  type MainTabKey,
  resolveMainTabKey,
} from '@/lib/navigation/mainNavigation';
import styles from './index.module.scss';

/**
 * 底部标签图标映射。
 */
const TAB_ICONS: Record<
  MainTabKey,
  React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
> = {
  chat: MessageCircle,
  library: LibraryBig,
  setting: Settings,
};

/**
 * 底部标签项配置定义。
 */
type TabConfig = {
  readonly key: MainTabKey;
  readonly title: string;
  readonly path: string;
  readonly icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
};

/**
 * 底部标签配置列表，数据源由 lib/navigation/mainNavigation 统一定义（创作、故事库、设置）。
 */
const TABS: readonly TabConfig[] = MAIN_TABS.map(tab => ({
  ...tab,
  icon: TAB_ICONS[tab.key],
}));

/**
 * 底部主导航栏组件，负责页面间跳转与全局导航指示。
 */
const MainTabBar: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const activeKey = resolveMainTabKey(pathname);

  useEffect(() => {
    TABS.forEach(tab => {
      router.prefetch(tab.path);
    });
  }, [router]);

  const handleTabClick = useCallback(
    (key: MainTabKey) => {
      const target = TABS.find(tab => tab.key === key);
      if (!target) return;
      // 当在 /player 时，虽然 activeKey 为 'library'（compatibility alias），
      // 但 target.path (/library) !== pathname (/player)，仍必须真正执行导航到 /library
      if (target.path !== pathname) {
        router.push(target.path);
      }
    },
    [pathname, router],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const currentIndex = TABS.findIndex(tab => tab.key === activeKey);
      if (currentIndex === -1) return;

      let nextIndex = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        nextIndex = (currentIndex + 1) % TABS.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
      } else if (e.key === 'Home') {
        e.preventDefault();
        nextIndex = 0;
      } else if (e.key === 'End') {
        e.preventDefault();
        nextIndex = TABS.length - 1;
      }

      if (nextIndex !== -1 && nextIndex !== currentIndex) {
        const nextTab = TABS[nextIndex];
        if (nextTab) {
          router.push(nextTab.path);
          const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]');
          buttons[nextIndex]?.focus();
        }
      }
    },
    [activeKey, router],
  );

  const hasUnviewedResponse = useChatStore(state => state.hasUnviewedResponse);

  return (
    <div className={styles.tabBarOuter}>
      <nav className={styles.tabBar} role="tablist" aria-label="主导航" onKeyDown={handleKeyDown}>
        {TABS.map(({ key, title, icon: Icon }) => {
          const isActive = activeKey === key;
          const isChat = key === 'chat';
          const isChatActive = activeKey === 'chat';
          const showBadge = isChat && !isChatActive && hasUnviewedResponse;

          return (
            <button
              key={key}
              role="tab"
              type="button"
              tabIndex={isActive ? 0 : -1}
              aria-selected={isActive}
              className={`${styles.tabItem} ${isActive ? styles.tabItemActive : ''}`}
              onClick={() => handleTabClick(key)}
            >
              <span className={styles.iconWrapper}>
                <Icon
                  size={22}
                  strokeWidth={isActive ? 2 : 1.5}
                  className={isActive ? styles.iconActive : styles.icon}
                />
                {showBadge && <span className={styles.badge} aria-label="有新消息" />}
              </span>
              <span className={styles.tabLabel}>{title}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
};

export default MainTabBar;
