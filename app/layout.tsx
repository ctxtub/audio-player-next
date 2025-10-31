import React from 'react';
import '@/styles/index.css';
import styles from '@/styles/app.module.scss';
import { ThemeProvider } from '@/components/ThemeProvider';
import {
  FALLBACK_THEME,
  THEME_COLORS,
  INITIAL_THEME_SCRIPT,
} from '@/components/ThemeProvider/themeConfig';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const htmlAttributes: Record<string, string> = {
    lang: 'zh'
  };

  return (
    <html {...htmlAttributes}>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content={THEME_COLORS[FALLBACK_THEME]} />
        <script dangerouslySetInnerHTML={{ __html: INITIAL_THEME_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <div className={styles.app}>
            {children}
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
