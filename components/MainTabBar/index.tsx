'use client';

import React, { useCallback } from 'react';
import { TabBar } from 'antd-mobile';
import { AppOutline, SetOutline } from 'antd-mobile-icons';
import { usePathname, useRouter } from 'next/navigation';
import styles from './index.module.scss';

const TABS = [
  {
    key: 'home',
    title: '首页',
    icon: <AppOutline />,
    path: '/',
  },
  {
    key: 'setting',
    title: '设置',
    icon: <SetOutline />,
    path: '/setting',
  },
] as const;

const resolveActiveKey = (pathname: string): (typeof TABS)[number]['key'] => {
  if (pathname.startsWith('/setting')) {
    return 'setting';
  }
  return 'home';
};

const MainTabBar: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const activeKey = resolveActiveKey(pathname);

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
