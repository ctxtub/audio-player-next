import React from 'react';
import { Inter, Instrument_Serif, JetBrains_Mono } from 'next/font/google';
import '@/styles/index.scss';
import { ThemeProvider } from '@/components/ThemeProvider';
import {
  FALLBACK_THEME,
  THEME_COLORS,
  INITIAL_THEME_SCRIPT,
} from '@/components/ThemeProvider/themeConfig';

/** Inter：主 sans 字体，覆盖拉丁字符集。 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

/** Instrument Serif：展示级衬线字体，加载正常体与斜体。 */
const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-instrument-serif',
  display: 'swap',
});

/** JetBrains Mono：等宽字体，加载 400 与 500 字重。 */
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

/**
 * 应用根布局，注入 next/font 三字体变量与全局 Provider。
 * TabBar / AudioController 等主应用专属布局在 (main)/layout.tsx 中。
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const fontClassName = [
    inter.variable,
    instrumentSerif.variable,
    jetbrainsMono.variable,
  ].join(' ');

  return (
    <html
      lang="zh"
      data-theme={FALLBACK_THEME}
      className={fontClassName}
      suppressHydrationWarning
    >
      <head>
        <title>故事工坊</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
        <meta name="theme-color" content={THEME_COLORS[FALLBACK_THEME]} />
        <script dangerouslySetInnerHTML={{ __html: INITIAL_THEME_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
