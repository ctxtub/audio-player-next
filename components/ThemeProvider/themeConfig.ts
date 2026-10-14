import type { ThemeMode, ThemePalette } from '@/types/theme';

/**
 * 可实际应用的主题值，排除跟随系统选项。
 */
export type ThemeValue = Exclude<ThemeMode, 'system'>;

/**
 * 主题状态结构，包含用户选择、系统偏好、最终主题及当前调性色板。
 */
export interface ThemeState {
  themeMode: ThemeMode;
  systemTheme: ThemeValue;
  resolvedTheme: ThemeValue;
  palette: ThemePalette;
}

/**
 * 默认兜底主题，避免闪烁。
 */
export const FALLBACK_THEME: ThemeValue = 'dark';
/**
 * 默认调性色板（暖琥珀壁炉）。
 */
export const DEFAULT_PALETTE: ThemePalette = 'amber';
/**
 * 主题切换顺序，供循环切换使用。
 */
export const THEME_SEQUENCE: ThemeMode[] = ['light', 'dark', 'system'];
/**
 * 持久化主题模式的本地存储键名。
 */
export const THEME_MODE_STORAGE_KEY = 'theme-mode';
/**
 * 持久化调性色板的本地存储键名。
 */
export const THEME_PALETTE_STORAGE_KEY = 'theme-palette';

/**
 * 各色板及亮暗模式对应的顶栏/背景色，控制浏览器元数据主题色。
 */
export const THEME_BG_COLORS: Record<ThemePalette, Record<ThemeValue, string>> = {
  amber: {
    dark: '#0F0E0D',
    light: '#FAF7F2',
  },
  midnight: {
    dark: '#0A0E17',
    light: '#F5F7FA',
  },
  forest: {
    dark: '#0A120E',
    light: '#F4F7F5',
  },
  mocha: {
    dark: '#110E0C',
    light: '#F9F6F0',
  },
};

/**
 * 兼容旧版的全局主题颜色映射。
 */
export const THEME_COLORS: Record<ThemeValue, string> = {
  dark: '#0F0E0D',
  light: '#FAF7F2',
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
  if (typeof window !== 'undefined' && window.__INITIAL_THEME_STATE__) {
    return window.__INITIAL_THEME_STATE__;
  }

  return {
    themeMode: 'system',
    systemTheme: FALLBACK_THEME,
    resolvedTheme: FALLBACK_THEME,
    palette: DEFAULT_PALETTE,
  };
};

const serializedBgColors = JSON.stringify(THEME_BG_COLORS);

/**
 * 服务端注入的初始化脚本，确保首屏主题与调性色板双一致，杜绝闪烁。
 */
export const INITIAL_THEME_SCRIPT = `
(function() {
  try {
    var modeKey = '${THEME_MODE_STORAGE_KEY}';
    var paletteKey = '${THEME_PALETTE_STORAGE_KEY}';
    var fallbackTheme = '${FALLBACK_THEME}';
    var fallbackPalette = '${DEFAULT_PALETTE}';
    var bgColors = ${serializedBgColors};

    var themeMode = 'system';
    try {
      var storedMode = window.localStorage.getItem(modeKey);
      if (storedMode === 'light' || storedMode === 'dark' || storedMode === 'system') {
        themeMode = storedMode;
      }
    } catch (e) {
      themeMode = 'system';
    }

    var palette = fallbackPalette;
    try {
      var storedPalette = window.localStorage.getItem(paletteKey);
      if (storedPalette === 'amber' || storedPalette === 'midnight' || storedPalette === 'forest' || storedPalette === 'mocha') {
        palette = storedPalette;
      }
    } catch (e) {
      palette = fallbackPalette;
    }

    var systemTheme = fallbackTheme;
    try {
      if (window.matchMedia) {
        systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
    } catch (e) {
      systemTheme = fallbackTheme;
    }

    var resolvedTheme = themeMode === 'system' ? systemTheme : themeMode;
    if (resolvedTheme !== 'light' && resolvedTheme !== 'dark') {
      resolvedTheme = fallbackTheme;
    }

    window.__INITIAL_THEME_STATE__ = {
      themeMode: themeMode,
      systemTheme: systemTheme,
      resolvedTheme: resolvedTheme,
      palette: palette
    };

    var doc = document.documentElement;
    doc.setAttribute('data-theme', resolvedTheme);
    doc.setAttribute('data-palette', palette);

    var metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor && bgColors[palette] && bgColors[palette][resolvedTheme]) {
      metaThemeColor.setAttribute('content', bgColors[palette][resolvedTheme]);
    }
  } catch (error) {
    // swallow errors silently to avoid blocking render
  }
})();
`;
