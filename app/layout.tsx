import React from 'react';
import 'antd-mobile/es/global';
import '@/styles/index.css';
import { ThemeProvider } from '@/components/ThemeProvider';
import { AntdMobileCompat } from '@/components/AntdMobileCompat';
import {
  FALLBACK_THEME,
  THEME_COLORS,
  INITIAL_THEME_SCRIPT,
} from '@/components/ThemeProvider/themeConfig';

/**
 * 应用根布局，注入主题脚本与全局 Provider。
 * TabBar / AudioController 等主应用专属布局在 (main)/layout.tsx 中。
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh" data-theme={FALLBACK_THEME} suppressHydrationWarning>
      <head>
        <title>故事工坊</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content={THEME_COLORS[FALLBACK_THEME]} />
        <script dangerouslySetInnerHTML={{ __html: INITIAL_THEME_SCRIPT }} />
      </head>
      <body>
        <AntdMobileCompat />
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
