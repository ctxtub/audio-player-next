import type { ThemeMode } from "@/types/theme";

/**
 * 可实际应用的主题值，排除跟随系统选项。
 */
export type ThemeValue = Exclude<ThemeMode, "system">;

/**
 * 主题状态结构，包含用户选择、系统偏好及最终主题。
 */
export interface ThemeState {
  themeMode: ThemeMode;
  systemTheme: ThemeValue;
  resolvedTheme: ThemeValue;
}

/**
 * 默认兜底主题，避免闪烁。
 */
export const FALLBACK_THEME: ThemeValue = "dark";
/**
 * 主题切换顺序，供循环切换使用。
 */
export const THEME_SEQUENCE: ThemeMode[] = ["light", "dark", "system"];
/**
 * 持久化主题模式的本地存储键名。
 */
export const THEME_MODE_STORAGE_KEY = "theme-mode";
/**
 * 主题颜色映射，控制浏览器主题色。
 */
export const THEME_COLORS: Record<ThemeValue, string> = {
  dark: "#000000",
  light: "#f2f2f7",
};

declare global {
  interface Window {
    __INITIAL_THEME_STATE__?: ThemeState;
  }
}

/**
 * 读取初始主题状态，优先使用服务端注入结果。
 * @returns 当前环境的主题状态
 */
export const getInitialThemeState = (): ThemeState => {
  if (typeof window !== "undefined" && window.__INITIAL_THEME_STATE__) {
    return window.__INITIAL_THEME_STATE__;
  }

  return {
    themeMode: "system",
    systemTheme: FALLBACK_THEME,
    resolvedTheme: FALLBACK_THEME,
  };
};

const serializedThemeColors = JSON.stringify(THEME_COLORS);

/**
 * 服务端注入的初始化脚本，确保首屏主题一致。
 */
export const INITIAL_THEME_SCRIPT = `
(function() {
  try {
    var storageKey = '${THEME_MODE_STORAGE_KEY}';
    var fallback = '${FALLBACK_THEME}';
    var colors = ${serializedThemeColors};
    var themeMode = 'system';
    try {
      var stored = window.localStorage.getItem(storageKey);
      if (stored === 'light' || stored === 'dark' || stored === 'system') {
        themeMode = stored;
      }
    } catch (error) {
      themeMode = 'system';
    }

    var systemTheme = fallback;
    try {
      if (window.matchMedia) {
        systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
    } catch (error) {
      systemTheme = fallback;
    }

    var resolvedTheme = themeMode === 'system' ? systemTheme : themeMode;
    if (resolvedTheme !== 'light' && resolvedTheme !== 'dark') {
      resolvedTheme = fallback;
    }

    window.__INITIAL_THEME_STATE__ = {
      themeMode: themeMode,
      systemTheme: systemTheme,
      resolvedTheme: resolvedTheme
    };

    var doc = document.documentElement;
    doc.setAttribute('data-theme', resolvedTheme);

    var metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor && colors[resolvedTheme]) {
      metaThemeColor.setAttribute('content', colors[resolvedTheme]);
    }
  } catch (error) {
    // swallow errors silently to avoid blocking render
  }
})();
`;
