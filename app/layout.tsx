import React from "react";
import "antd-mobile/es/global";
import "@/styles/index.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { AntdMobileCompat } from "@/components/AntdMobileCompat";
import MainTabBar from "@/components/MainTabBar";
import AudioControllerHost from "@/components/AudioControllerHost";
import { FloatingPlayer } from "@/components/FloatingPlayer";
import ConfigInitializer from "@/components/ConfigInitializer";
import {
  FALLBACK_THEME,
  THEME_COLORS,
  INITIAL_THEME_SCRIPT,
} from "@/components/ThemeProvider/themeConfig";

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
      <body className="min-h-screen">
        <AntdMobileCompat />
        <ThemeProvider>
          <ConfigInitializer>
            <div
              className="relative mx-auto flex min-h-screen w-full max-w-[var(--size-max-width-modal)] flex-col"
              style={{
                backgroundColor:
                  "var(--color-background-initial, var(--color-background, #000000))",
                color:
                  "var(--color-foreground-initial, var(--color-foreground, #ffffff))",
                transition:
                  "background-color var(--motion-duration-theme) var(--motion-ease-theme), color var(--motion-duration-theme) var(--motion-ease-theme)",
              }}
            >
              <main className="flex-1 overflow-y-auto pb-[calc(var(--main-tab-bar-height,56px)+24px+env(safe-area-inset-bottom))]">
                {children}
              </main>
              <MainTabBar />
            </div>
            <AudioControllerHost />
            <FloatingPlayer />
          </ConfigInitializer>
        </ThemeProvider>
      </body>
    </html>
  );
}
