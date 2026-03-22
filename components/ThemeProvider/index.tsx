'use client';

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
} from 'react';
import type { ThemeMode } from '@/types/theme';
import {
  THEME_MODE_STORAGE_KEY,
  THEME_SEQUENCE,
  THEME_COLORS,
  getInitialThemeState,
} from './themeConfig';
import type { ThemeValue, ThemeState } from './themeConfig';

/**
 * 主题上下文的状态结构。
 */
interface ThemeContextType {
  currentTheme: ThemeValue;
  themeMode: ThemeMode;
  toggleTheme: () => void;
  setThemeMode: (mode: ThemeMode) => void;
}

/**
 * 初始化主题状态，读取存储或系统偏好。
 */
const INITIAL_THEME_STATE: ThemeState = getInitialThemeState();

/**
 * 主题上下文实例，提供主题状态读写。
 */
const ThemeContext = createContext<ThemeContextType>({
  currentTheme: INITIAL_THEME_STATE.resolvedTheme,
  themeMode: INITIAL_THEME_STATE.themeMode,
  toggleTheme: () => {},
  setThemeMode: () => {},
});

/**
 * 获取主题上下文的快捷 Hook。
 * @returns 主题上下文状态与操作
 */
export const useTheme = () => useContext(ThemeContext);

/**
 * 主题 Provider，负责管理主题状态并同步至文档。
 * @param children 需要包裹的子节点
 * @returns 包裹 ConfigProvider 的主题上下文
 */
export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [themeMode, setThemeMode] = useState<ThemeMode>(INITIAL_THEME_STATE.themeMode);
  const [systemTheme, setSystemTheme] = useState<ThemeValue>(INITIAL_THEME_STATE.systemTheme);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? 'dark' : 'light');
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleChange);
    } else {
      mediaQuery.addListener(handleChange);
    }

    setSystemTheme(mediaQuery.matches ? 'dark' : 'light');

    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', handleChange);
      } else {
        mediaQuery.removeListener(handleChange);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(THEME_MODE_STORAGE_KEY, themeMode);
    } catch {
      // ignore storage write failures
    }
  }, [themeMode]);

  const resolvedTheme: ThemeValue = useMemo(
    () => themeMode === 'system' ? systemTheme : themeMode,
    [themeMode, systemTheme]
  );

  const handleSetThemeMode = useCallback((mode: ThemeMode) => {
    setThemeMode(mode);
  }, []);

  const toggleTheme = useCallback(() => {
    const currentIndex = THEME_SEQUENCE.indexOf(themeMode);
    const nextMode =
      currentIndex === -1
        ? 'light'
        : THEME_SEQUENCE[(currentIndex + 1) % THEME_SEQUENCE.length];
    setThemeMode(nextMode);
  }, [themeMode]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const docEl = document.documentElement;
    if (docEl.getAttribute('data-theme') !== resolvedTheme) {
      docEl.setAttribute('data-theme', resolvedTheme);
    }

    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor && THEME_COLORS[resolvedTheme]) {
      metaThemeColor.setAttribute('content', THEME_COLORS[resolvedTheme]);
    }

  }, [resolvedTheme]);

  const contextValue = useMemo(
    () => ({
      currentTheme: resolvedTheme,
      themeMode,
      toggleTheme,
      setThemeMode: handleSetThemeMode,
    }),
    [resolvedTheme, themeMode, toggleTheme, handleSetThemeMode]
  );

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
};
