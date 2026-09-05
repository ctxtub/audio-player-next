'use client';

import React, { useEffect, useRef } from 'react';
import { useTheme } from '@/components/ThemeProvider';
import { useConfigStore } from '@/stores/configStore';
import { THEME_MODE_STORAGE_KEY } from '@/components/ThemeProvider/themeConfig';

/**
 * 主题水合桥（全主体通用）：首屏利用 localStorage['theme-mode'] 防闪烁；
 * 客户端水合后，以服务端云端配置（GuestConfig 或 UserConfig）为准并回写覆盖 localStorage。
 *
 * 采用单向下发：
 * - 当 configStore.isLoaded 为 true 时，服务端 themeMode 一次性生效覆盖本地；
 * - 用户在 UI 切换主题时，由 ThemeProvider 立即写 localStorage，并由 configStore 防抖同步云端；
 * - 登出时不清除 localStorage['theme-mode']；当 isLoaded 重置时复位 hydratedRef，便于下一次会话水合。
 */
const ThemeConfigBridge: React.FC = () => {
  const { themeMode, setThemeMode } = useTheme();
  const isLoaded = useConfigStore(state => state.isLoaded);
  const configThemeMode = useConfigStore(state => state.apiConfig.themeMode);

  /** 是否已完成「服务端权威值 → ThemeProvider」下发。 */
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!isLoaded) {
      hydratedRef.current = false;
      return;
    }
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      if (themeMode !== configThemeMode) {
        setThemeMode(configThemeMode);
        try {
          window.localStorage.setItem(THEME_MODE_STORAGE_KEY, configThemeMode);
        } catch {
          // ignore storage write failures
        }
      }
    }
  }, [isLoaded, configThemeMode, themeMode, setThemeMode]);

  return null;
};

export default ThemeConfigBridge;
