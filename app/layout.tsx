import React from 'react';
import 'antd-mobile/es/global';
import '@/styles/index.css';
import styles from '@/styles/app.module.scss';
import { ThemeProvider } from '@/components/ThemeProvider';
import { AntdMobileCompat } from '@/components/AntdMobileCompat';
import MainTabBar from '@/components/MainTabBar';
import AudioControllerHost from '@/components/AudioControllerHost';
import { FloatingPlayer } from '@/components/FloatingPlayer';
import {
  FALLBACK_THEME,
  THEME_COLORS,
  INITIAL_THEME_SCRIPT,
} from '@/components/ThemeProvider/themeConfig';

/**
 * 应用根布局，注入主题脚本与全局导航。
 * @param children 页面渲染内容
 * @returns 包裹全局 Provider 的 HTML 结构
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh" data-theme={FALLBACK_THEME} suppressHydrationWarning>
      <head>
        <title>AI播放器</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content={THEME_COLORS[FALLBACK_THEME]} />
        <script dangerouslySetInnerHTML={{ __html: INITIAL_THEME_SCRIPT }} />
      </head>
      <body>
        <AntdMobileCompat />
        <ThemeProvider>
          <div className={styles.app}>
            <main className={styles.content}>
              {children}
            </main>
            <MainTabBar />
          </div>
          <AudioControllerHost />
          <FloatingPlayer />
        </ThemeProvider>
      </body>
    </html>
  );
}
