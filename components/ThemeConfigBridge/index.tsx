'use client';

import React, { useEffect, useRef } from 'react';
import { useTheme } from '@/components/ThemeProvider';
import { useConfigStore } from '@/stores/configStore';

/**
 * 主题水合桥（仅登录态生效）：登录后把服务端权威的 themeMode 一次性下发给 ThemeProvider。
 *
 * 采用「单向下发」而非双向 diff——用户改主题由设置页显式写回配置（见 setting 页 onChange），
 * 因此这里无需回写逻辑，彻底规避「下发后 themeMode 尚未传播 → 被误判为用户改动 → 回写」的竞态
 * （含 React StrictMode 对 effect 的双调用）。
 *
 * hydratedRef 保证仅在「首次进入登录态」时下发一次；登出后（syncEnabled=false）复位，便于下次登录重新下发。
 * 访客/未登录时惰性，ThemeProvider 维持自有 localStorage 行为。
 */
const ThemeConfigBridge: React.FC = () => {
  const { themeMode, setThemeMode } = useTheme();
  const syncEnabled = useConfigStore(state => state.syncEnabled);
  const configThemeMode = useConfigStore(state => state.apiConfig.themeMode);

  /** 是否已完成首次「服务端 → ThemeProvider」下发。 */
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!syncEnabled) {
      hydratedRef.current = false;
      return;
    }
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      if (themeMode !== configThemeMode) {
        setThemeMode(configThemeMode);
      }
    }
  }, [syncEnabled, configThemeMode, themeMode, setThemeMode]);

  return null;
};

export default ThemeConfigBridge;
