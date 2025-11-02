'use client';

import React, { useCallback, useEffect } from 'react';
import { TabBar } from 'antd-mobile';
import { AppOutline, SoundOutline, SetOutline } from 'antd-mobile-icons';
import { usePathname, useRouter } from 'next/navigation';
import styles from './index.module.scss';

/**
 * 底部标签配置，定义导航目标与图标。
 */
const TABS = [
  {
    key: 'home',
    title: '首页',
    icon: <AppOutline />,
    path: '/',
  },
  {
    key: 'player',
    title: '播放器',
    icon: <SoundOutline />,
    path: '/player',
  },
  {
    key: 'setting',
    title: '设置',
    icon: <SetOutline />,
    path: '/setting',
  },
] as const;

/**
 * 根据路径解析激活的标签键。
 * @param pathname 当前路由路径
 * @returns 对应的标签 key
 */
const resolveActiveKey = (pathname: string): (typeof TABS)[number]['key'] => {
  if (pathname.startsWith('/player')) {
    return 'player';
  }
  if (pathname.startsWith('/setting')) {
    return 'setting';
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
    router.prefetch('/player');
    router.prefetch('/setting');
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

  return (
    <div className={styles.tabBarContainer}>
      <TabBar activeKey={activeKey} onChange={handleTabChange} safeArea>
        {TABS.map(({ key, title, icon }) => (
          <TabBar.Item key={key} icon={icon} title={title} />
        ))}
      </TabBar>
    </div>
  );
};

export default MainTabBar;
