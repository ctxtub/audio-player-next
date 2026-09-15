'use client';

import React, { useCallback, useEffect, useMemo } from 'react';

import { PageLoading } from '@/components/PageLoading';
import { useTheme } from '@/components/ThemeProvider';
import { useConfigStore } from '@/stores/configStore';
import { useAuthStore } from '@/stores/authStore';
import styles from './index.module.scss';
import DefaultSleepTimerSection from './components/DefaultSleepTimerSection';
import DesktopFloatingPlayerSection from './components/DesktopFloatingPlayerSection';
import ThemeModeSection from './components/ThemeModeSection';
import VoiceServiceSection from './components/VoiceServiceSection';
import SpeedConfigSection from './components/SpeedConfigSection';
import UserSection from './components/UserSection';

/**
 * 设置页面组件，承载播放配置与主题切换。
 * @returns 设置页 JSX 结构
 */
const ConfigPage: React.FC = () => {
  const apiConfig = useConfigStore(state => state.apiConfig);
  const updateConfig = useConfigStore(state => state.update);
  const isConfigLoaded = useConfigStore(state => state.isLoaded);
  const voiceOptions = useConfigStore(state => state.voiceOptions);
  const { themeMode, setThemeMode } = useTheme();
  const fetchAuthProfile = useAuthStore(state => state.fetchProfile);

  useEffect(() => {
    if (!isConfigLoaded || voiceOptions.length === 0) {
      return;
    }

    const isVoiceValid = voiceOptions.some(option => option.value === apiConfig.voiceId);
    if (isVoiceValid) {
      return;
    }

    const fallbackVoice = voiceOptions[0]?.value;
    if (fallbackVoice && fallbackVoice !== apiConfig.voiceId) {
      updateConfig({ voiceId: fallbackVoice });
    }
  }, [apiConfig.voiceId, isConfigLoaded, updateConfig, voiceOptions]);

  /**
   * 当前有效的语音配置值。
   */
  const selectedVoice = useMemo(() => {
    if (!isConfigLoaded) {
      return undefined;
    }
    const matchedVoice = voiceOptions.find(option => option.value === apiConfig.voiceId);
    return matchedVoice?.value;
  }, [apiConfig.voiceId, isConfigLoaded, voiceOptions]);

  /**
   * M7-03 默认睡眠定时分钟数（新语义字段；旧 playDuration 别名同值保留）。
   */
  const defaultSleepTimerMinutes = useMemo(
    () => apiConfig.defaultSleepTimerMinutes,
    [apiConfig.defaultSleepTimerMinutes]
  );

  /**
   * M7-03 默认睡眠定时开关。
   */
  const defaultSleepTimerEnabled = useMemo(
    () => apiConfig.defaultSleepTimerEnabled,
    [apiConfig.defaultSleepTimerEnabled]
  );

  const handleDefaultSleepTimerMinutesChange = useCallback(
    (value: number) => {
      if (!isConfigLoaded) {
        return;
      }
      if (value === apiConfig.defaultSleepTimerMinutes) {
        return;
      }
      updateConfig({ defaultSleepTimerMinutes: value });
    },
    [apiConfig.defaultSleepTimerMinutes, isConfigLoaded, updateConfig]
  );

  const handleDefaultSleepTimerEnabledChange = useCallback(
    (value: boolean) => {
      if (!isConfigLoaded) {
        return;
      }
      if (value === apiConfig.defaultSleepTimerEnabled) {
        return;
      }
      updateConfig({ defaultSleepTimerEnabled: value });
    },
    [apiConfig.defaultSleepTimerEnabled, isConfigLoaded, updateConfig]
  );

  /**
   * 是否在宽屏启用悬浮迷你播放器（M6 语义；移动端始终 docked）。
   */
  const isDesktopFloatingPlayerEnabled = useMemo(
    () => apiConfig.desktopFloatingPlayerEnabled,
    [apiConfig.desktopFloatingPlayerEnabled]
  );

  const handleVoiceSelect = useCallback(
    (voice: string) => {
      if (!isConfigLoaded) {
        return;
      }
      if (!voice || voice === apiConfig.voiceId) {
        return;
      }

      const isVoiceValid = voiceOptions.some(option => option.value === voice);
      if (!isVoiceValid) {
        return;
      }

      updateConfig({ voiceId: voice });
    },
    [apiConfig.voiceId, isConfigLoaded, updateConfig, voiceOptions]
  );

  const handleSpeedChange = useCallback(
    (speed: number) => {
      if (!isConfigLoaded) return;
      if (speed === apiConfig.speed) return;
      updateConfig({ speed });
    },
    [apiConfig.speed, isConfigLoaded, updateConfig]
  );

  const handleDesktopFloatingPlayerToggle = useCallback((enabled: boolean) => {
    if (!isConfigLoaded) {
      return;
    }
    if (enabled === apiConfig.desktopFloatingPlayerEnabled) {
      return;
    }
    updateConfig({ desktopFloatingPlayerEnabled: enabled });
  }, [apiConfig.desktopFloatingPlayerEnabled, isConfigLoaded, updateConfig]);

  /**
   * 主题切换：既更新 ThemeProvider（即时生效），又写回 configStore（登录态下防抖同步服务端）。
   */
  const handleThemeModeChange = useCallback(
    (mode: typeof themeMode) => {
      if (mode === themeMode) {
        return;
      }
      setThemeMode(mode);
      updateConfig({ themeMode: mode });
    },
    [themeMode, setThemeMode, updateConfig]
  );

  useEffect(() => {
    fetchAuthProfile();
  }, [fetchAuthProfile]);

  if (!isConfigLoaded) {
    return <PageLoading message="页面加载中..." />;
  }

  return (
    <div className={styles.configPage}>
      <div className={styles.settingsHero}>
        <p className={styles.heroLabel}>Settings</p>
        <h1 className={styles.heroTitle}>个人偏好</h1>
      </div>
      <div className={styles.configForm}>
        <UserSection />
        <ThemeModeSection value={themeMode} onChange={handleThemeModeChange} />
        <DefaultSleepTimerSection
          enabled={defaultSleepTimerEnabled}
          minutes={defaultSleepTimerMinutes}
          onEnabledChange={handleDefaultSleepTimerEnabledChange}
          onMinutesChange={handleDefaultSleepTimerMinutesChange}
        />
        <SpeedConfigSection
          speed={apiConfig.speed}
          onSpeedChange={handleSpeedChange}
        />
        <DesktopFloatingPlayerSection
          value={isDesktopFloatingPlayerEnabled}
          onChange={handleDesktopFloatingPlayerToggle}
        />
        <VoiceServiceSection
          value={selectedVoice}
          voicesList={voiceOptions}
          onChange={handleVoiceSelect}
        />
      </div>
    </div>
  );
};

export default ConfigPage;
