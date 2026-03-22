'use client';

import React, { useCallback, useEffect } from 'react';
import { MessageCircle, Disc3, Settings } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useChatStore } from '@/stores/chatStore';
import styles from './index.module.scss';

/**
 * 底部标签配置，定义导航目标与图标。
 */
type TabConfig = {
  /** 标签唯一 key。 */
  key: 'chat' | 'player' | 'setting';
  /** 标签展示名称。 */
  title: string;
  /** 对应的路由路径。 */
  path: string;
  /** 图标组件。 */
  icon: React.FC<{ size?: number; strokeWidth?: number; className?: string }>;
  /** 自定义激活判断逻辑。 */
  isActive?: (pathname: string) => boolean;
};

/**
 * 底部标签配置数组，提供渲染与路由跳转信息。
 */
const TABS: readonly TabConfig[] = [
  {
    key: 'chat',
    title: '创作',
    icon: MessageCircle,
    path: '/chat',
    isActive: pathname => pathname === '/' || pathname.startsWith('/chat'),
  },
  {
    key: 'player',
    title: '播放器',
    icon: Disc3,
    path: '/player',
    isActive: pathname => pathname === '/player',
  },
  {
    key: 'setting',
    title: '设置',
    icon: Settings,
    path: '/setting',
    isActive: pathname => pathname.startsWith('/setting'),
  },
];

/**
 * 根据路径解析激活的标签键。
 * @param pathname 当前路由路径
 * @returns 对应的标签 key
 */
const resolveActiveKey = (pathname: string): TabConfig['key'] => {
  const matchedTab = TABS.find(tab => tab.isActive?.(pathname));
  return matchedTab?.key ?? 'chat';
};

/**
 * 底部主导航栏组件，负责页面间跳转。
 */
const MainTabBar: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const activeKey = resolveActiveKey(pathname);

  useEffect(() => {
    TABS.forEach(tab => {
      router.prefetch(tab.path);
    });
  }, [router]);

  const handleTabClick = useCallback(
    (key: string) => {
      const target = TABS.find(tab => tab.key === key);
      if (!target) return;
      if (target.path !== pathname) {
        router.push(target.path);
      }
    },
    [pathname, router],
  );

  const hasUnviewedResponse = useChatStore(state => state.hasUnviewedResponse);

  return (
    <nav className={styles.tabBar} role="tablist" aria-label="主导航">
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
            aria-selected={isActive}
            className={`${styles.tabItem} ${isActive ? styles.tabItemActive : ''}`}
            onClick={() => handleTabClick(key)}
          >
            <span className={styles.iconWrapper}>
              <Icon
                size={24}
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
  );
};

export default MainTabBar;
