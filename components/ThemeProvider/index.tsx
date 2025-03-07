'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { Theme } from '@/types/types';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  systemTheme: Theme;
  useSystemTheme: boolean;
  setUseSystemTheme: (use: boolean) => void;
}

// 获取初始状态，优先使用预设的全局变量
const getInitialThemeState = () => {
  if (typeof window !== 'undefined') {
    // 优先使用预设的全局变量，确保与layout.tsx中的脚本一致
    if (window.__INITIAL_THEME__ && window.__THEME_INITIALIZED__) {
      const initial = window.__INITIAL_THEME__;
      return {
        userTheme: initial.theme,
        systemTheme: initial.systemTheme,
        useSystemTheme: initial.useSystemTheme,
        appliedTheme: initial.appliedTheme
      };
    }
    
    // 降级处理：重新计算（应该很少发生）
    try {
      const savedTheme = localStorage.getItem('theme') as Theme;
      const savedUseSystemTheme = localStorage.getItem('useSystemTheme');
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      
      const useSystemTheme = savedUseSystemTheme !== null ? savedUseSystemTheme === 'true' : true;
      const userTheme = (savedTheme && (savedTheme === 'dark' || savedTheme === 'light')) ? savedTheme : systemTheme;
      const appliedTheme = useSystemTheme ? systemTheme : userTheme;
      
      return {
        userTheme,
        systemTheme,
        useSystemTheme,
        appliedTheme
      };
    } catch {
      // 最终降级
      return {
        userTheme: 'dark' as Theme,
        systemTheme: 'dark' as Theme,
        useSystemTheme: true,
        appliedTheme: 'dark' as Theme
      };
    }
  }
  
  // 服务端渲染时的默认值
  return {
    userTheme: 'dark' as Theme,
    systemTheme: 'dark' as Theme,
    useSystemTheme: true,
    appliedTheme: 'dark' as Theme
  };
};

const ThemeContext = createContext<ThemeContextType>({
  theme: 'dark',
  toggleTheme: () => {},
  systemTheme: 'dark',
  useSystemTheme: true,
  setUseSystemTheme: () => {},
});

export const useTheme = () => useContext(ThemeContext);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // 获取初始状态，只在组件内部调用一次
  const initialState = getInitialThemeState();
  
  const [theme, setTheme] = useState<Theme>(initialState.userTheme);
  const [systemTheme, setSystemTheme] = useState<Theme>(initialState.systemTheme);
  const [useSystemTheme, setUseSystemTheme] = useState<boolean>(initialState.useSystemTheme);

  // 监听系统主题变化
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? 'dark' : 'light');
    };

    // 添加事件监听
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleChange);
    } else {
      // 兼容旧版浏览器
      mediaQuery.addListener(handleChange);
    }

    // 清理函数
    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', handleChange);
      } else {
        mediaQuery.removeListener(handleChange);
      }
    };
  }, []);

  // 应用主题到DOM
  useEffect(() => {
    const themeToApply = useSystemTheme ? systemTheme : theme;
    
    // 只有当DOM主题与要应用的主题不同时才更新
    const currentDOMTheme = document.documentElement.getAttribute('data-theme');
    if (currentDOMTheme !== themeToApply) {
      document.documentElement.setAttribute('data-theme', themeToApply);
      
      // 更新 meta theme-color 标签
      const metaThemeColor = document.querySelector('meta[name="theme-color"]');
      if (metaThemeColor) {
        metaThemeColor.setAttribute('content', themeToApply === 'dark' ? '#000000' : '#f2f2f7');
      }
    }

    document.documentElement.style.setProperty('color-scheme', themeToApply);
    document.documentElement.style.setProperty('--initial-background', themeToApply === 'dark' ? '#000000' : '#f2f2f7');
    document.documentElement.style.setProperty('--initial-foreground', themeToApply === 'dark' ? '#ffffff' : '#666666');

    if (typeof window !== 'undefined') {
      window.__INITIAL_THEME__ = {
        theme,
        systemTheme,
        useSystemTheme,
        appliedTheme: themeToApply
      };
      window.__THEME_INITIALIZED__ = true;
    }
  }, [theme, systemTheme, useSystemTheme]);

  // 保存设置到localStorage（只在用户设置变化时）
  useEffect(() => {
    try {
      localStorage.setItem('theme', theme);
      localStorage.setItem('useSystemTheme', String(useSystemTheme));
    } catch (error) {
      console.warn('Failed to save theme settings:', error);
    }

    try {
      const cookieOptions = 'path=/; max-age=31536000; SameSite=Lax';
      document.cookie = 'theme=' + theme + '; ' + cookieOptions;
      document.cookie = 'useSystemTheme=' + (useSystemTheme ? 'true' : 'false') + '; ' + cookieOptions;
    } catch (error) {
      console.warn('Failed to persist theme cookies:', error);
    }
  }, [theme, useSystemTheme]);

  const toggleTheme = () => {
    // 如果正在使用系统主题，切换到手动模式
    if (useSystemTheme) {
      setUseSystemTheme(false);
      // 设置为当前系统主题的反向
      setTheme(systemTheme === 'dark' ? 'light' : 'dark');
    } else {
      // 已经是手动模式，直接切换主题
      setTheme(prev => prev === 'dark' ? 'light' : 'dark');
    }
  };

  // 计算当前应该显示的主题
  const currentTheme = useSystemTheme ? systemTheme : theme;

  return (
    <ThemeContext.Provider value={{ 
      theme: currentTheme, 
      toggleTheme, 
      systemTheme, 
      useSystemTheme, 
      setUseSystemTheme 
    }}>
      {children}
    </ThemeContext.Provider>
  );
};
