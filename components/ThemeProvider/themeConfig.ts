import { ThemeMode } from '@/types/types';

export type ThemeValue = Exclude<ThemeMode, 'system'>;

export interface ThemeState {
  themeMode: ThemeMode;
  systemTheme: ThemeValue;
  resolvedTheme: ThemeValue;
}

export const FALLBACK_THEME: ThemeValue = 'dark';
export const THEME_SEQUENCE: ThemeMode[] = ['light', 'dark', 'system'];
export const THEME_MODE_STORAGE_KEY = 'theme-mode';
export const THEME_COLORS: Record<ThemeValue, string> = {
  dark: '#000000',
  light: '#f2f2f7',
};

declare global {
  interface Window {
    __INITIAL_THEME_STATE__?: ThemeState;
  }
}

export const getInitialThemeState = (): ThemeState => {
  if (typeof window !== 'undefined' && window.__INITIAL_THEME_STATE__) {
    return window.__INITIAL_THEME_STATE__;
  }

  return {
    themeMode: 'system',
    systemTheme: FALLBACK_THEME,
    resolvedTheme: FALLBACK_THEME,
  };
};

const serializedThemeColors = JSON.stringify(THEME_COLORS);

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
