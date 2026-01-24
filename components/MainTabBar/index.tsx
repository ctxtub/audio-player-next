'use client';

import React, { useCallback, useEffect } from 'react';
import { TabBar, Badge } from 'antd-mobile';
import { AppOutline, MessageOutline, SetOutline } from 'antd-mobile-icons';
import { usePathname, useRouter } from 'next/navigation';
import { useChatStore } from '@/stores/chatStore';
import styles from './index.module.scss';

/**
 * 底部标签配置，定义导航目标与图标。
 */
type TabConfig = {
  /**
   * 标签唯一 key，与 `TabBar.Item` 对应。
   */
  key: 'home' | 'chat' | 'player' | 'setting';
  /**
   * 标签展示名称。
   */
  title: string;
  /**
   * 标签使用的图标组件。
   */
  icon: React.ReactNode;
  /**
   * 对应的路由路径。
   */
  path: string;
  /**
   * 自定义激活判断逻辑。
   */
  isActive?: (pathname: string) => boolean;
};

/**
 * 底部标签配置数组，提供渲染与路由跳转信息。
 */
const TABS: readonly TabConfig[] = [
  {
    key: 'home',
    title: '首页',
    icon: <AppOutline />,
    path: '/',
    isActive: pathname => pathname === '/',
  },
  {
    key: 'chat',
    title: '创作',
    icon: <MessageOutline />,
    path: '/chat',
    isActive: pathname => pathname.startsWith('/chat'),
  },

  {
    key: 'setting',
    title: '设置',
    icon: <SetOutline />,
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
  if (matchedTab) {
    return matchedTab.key;
  }
  return 'home';
};

/**
 * 底部主导航栏组件，负责页面间跳转。
 */
const MainTabBar: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const activeKey = resolveActiveKey(pathname);

  useEffect(() => {
    TABS.filter(tab => tab.path !== '/').forEach(tab => {
      router.prefetch(tab.path);
    });
  }, [router]);

  const handleTabChange = useCallback(
    (key: string) => {
      const target = TABS.find(tab => tab.key === key);
      if (!target) {
        return;
      }

      if (target.path !== pathname) {
        router.push(target.path);
      }
    },
    [pathname, router],
  );

  const hasUnread = useChatStore(state => state.hasUnread);

  return (
    <div className={styles.tabBarContainer}>
      <TabBar activeKey={activeKey} onChange={handleTabChange} safeArea>
        {TABS.map(({ key, title, icon }) => {
          const isChat = key === 'chat';
          const showBadge = isChat && hasUnread;
          return (
            <TabBar.Item
              key={key}
              icon={showBadge ? <Badge content={Badge.dot}>{icon}</Badge> : icon}
              title={title}
            />
          );
        })}
      </TabBar>
    </div>
  );
};

export default MainTabBar;
