import React from 'react';
import '@/styles/index.css';
import styles from '@/styles/app.module.scss';
import { ThemeProvider } from '@/components/ThemeProvider';
import { cookies, headers } from 'next/headers';

type ThemeValue = 'dark' | 'light';

const parseTheme = (value: string | null | undefined): ThemeValue | undefined => {
  if (value === 'dark' || value === 'light') {
    return value;
  }
  return undefined;
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = cookies();
  const themeFromCookie = parseTheme(cookieStore.get('theme')?.value);
  const useSystemThemeCookie = cookieStore.get('useSystemTheme');
  const useSystemTheme =
    useSystemThemeCookie?.value === 'true' ||
    (useSystemThemeCookie?.value === undefined && true);

  const requestHeaders = headers();
  const systemThemeHint = parseTheme(requestHeaders.get('sec-ch-prefers-color-scheme'));

  const appliedTheme = useSystemTheme ? systemThemeHint : themeFromCookie;

  const htmlAttributes: Record<string, string> = {
    lang: 'zh',
    'data-theme-transition': 'off',
  };

  if (appliedTheme) {
    htmlAttributes['data-theme'] = appliedTheme;
  }

  const initialThemePayload = {
    cookieTheme: themeFromCookie ?? null,
    useSystemThemeDefault: useSystemTheme,
    systemThemeHint: systemThemeHint ?? null,
    appliedTheme: appliedTheme ?? null,
  };

  return (
    <html {...htmlAttributes}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  const serverThemeData = ${JSON.stringify(initialThemePayload)};
                  const docEl = document.documentElement;

                  if (!docEl.hasAttribute('data-theme-transition')) {
                    docEl.setAttribute('data-theme-transition', 'off');
                  }

                  // 检测系统主题
                  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
                  const systemIsDark = mediaQuery.matches;
                  let systemTheme = systemIsDark ? 'dark' : 'light';
                  
                  // 读取保存的设置
                  let savedTheme = null;
                  let savedUseSystemTheme = null;
                  
                  try {
                    savedTheme = localStorage.getItem('theme');
                    savedUseSystemTheme = localStorage.getItem('useSystemTheme');
                  } catch (e) {
                    // localStorage 可能不可用（如隐私模式）
                    console.warn('localStorage not available:', e);
                  }
                  
                  // 确定初始状态
                  const useSystemTheme = savedUseSystemTheme !== null
                    ? savedUseSystemTheme === 'true'
                    : !!serverThemeData.useSystemThemeDefault;

                  if (useSystemTheme && serverThemeData.systemThemeHint) {
                    systemTheme = serverThemeData.systemThemeHint;
                  }

                  const userThemeCandidate = (savedTheme && (savedTheme === 'dark' || savedTheme === 'light'))
                    ? savedTheme
                    : (serverThemeData.cookieTheme && (serverThemeData.cookieTheme === 'dark' || serverThemeData.cookieTheme === 'light'))
                      ? serverThemeData.cookieTheme
                      : systemTheme;

                  const userTheme = userThemeCandidate;
                  
                  // 确定要应用的主题
                  const themeToApply = useSystemTheme ? systemTheme : userTheme;
                  
                  // 立即应用主题到DOM，避免闪烁
                  const currentTheme = docEl.getAttribute('data-theme');
                  if (currentTheme !== themeToApply) {
                    docEl.setAttribute('data-theme', themeToApply);
                  }
                  docEl.style.setProperty('color-scheme', themeToApply);
                  
                  // 确保body样式立即生效
                  docEl.style.setProperty('--initial-background', 
                    themeToApply === 'dark' ? '#000000' : '#f2f2f7');
                  docEl.style.setProperty('--initial-foreground', 
                    themeToApply === 'dark' ? '#ffffff' : '#666666');
                  
                  // 创建或更新 meta theme-color 标签
                  let metaThemeColor = document.querySelector('meta[name="theme-color"]');
                  if (!metaThemeColor) {
                    metaThemeColor = document.createElement('meta');
                    metaThemeColor.setAttribute('name', 'theme-color');
                    document.head.appendChild(metaThemeColor);
                  }
                  metaThemeColor.setAttribute('content', themeToApply === 'dark' ? '#000000' : '#f2f2f7');
                  
                  // 保存到全局变量，供ThemeProvider使用
                  window.__INITIAL_THEME__ = {
                    theme: userTheme,
                    systemTheme: systemTheme,
                    useSystemTheme: useSystemTheme,
                    appliedTheme: themeToApply
                  };
                  
                  // 标记初始化完成
                  window.__THEME_INITIALIZED__ = true;
                  
                  requestAnimationFrame(function() {
                    docEl.removeAttribute('data-theme-transition');
                  });
                  
                } catch (e) {
                  // 降级处理：如果出错，使用暗色主题
                  console.error('Theme initialization error:', e);
                  document.documentElement.setAttribute('data-theme', 'dark');
                  document.documentElement.style.setProperty('color-scheme', 'dark');
                  
                  // 创建或更新 meta theme-color 标签
                  let metaThemeColor = document.querySelector('meta[name="theme-color"]');
                  if (!metaThemeColor) {
                    metaThemeColor = document.createElement('meta');
                    metaThemeColor.setAttribute('name', 'theme-color');
                    document.head.appendChild(metaThemeColor);
                  }
                  metaThemeColor.setAttribute('content', '#000000');
                  
                  window.__INITIAL_THEME__ = {
                    theme: 'dark',
                    systemTheme: 'dark',
                    useSystemTheme: true,
                    appliedTheme: 'dark'
                  };
                  window.__THEME_INITIALIZED__ = true;

                  requestAnimationFrame(function() {
                    document.documentElement.removeAttribute('data-theme-transition');
                  });
                }
              })();
            `,
          }}
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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
