'use client';

import React, { useCallback, useEffect, useMemo } from 'react';

import { PageLoading } from '@/components/PageLoading';
import { useTheme } from '@/components/ThemeProvider';
import { useConfigStore } from '@/stores/configStore';
import styles from './index.module.scss';
import BasicConfigSection from './components/BasicConfigSection';
import FloatingPlayerSection from './components/FloatingPlayerSection';
import ThemeModeSection from './components/ThemeModeSection';
import VoiceServiceSection from './components/VoiceServiceSection';

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
   * 当前播放时长（分钟）。
   */
  const playDuration = useMemo(() => apiConfig.playDuration, [apiConfig.playDuration]);

  /**
   * 是否开启浮动播放器。
   */
  const isFloatingPlayerEnabled = useMemo(
    () => apiConfig.floatingPlayerEnabled,
    [apiConfig.floatingPlayerEnabled]
  );

  const handlePlayDurationChange = useCallback(
    (value: number) => {
      if (!isConfigLoaded) {
        return;
      }
      if (value === apiConfig.playDuration) {
        return;
      }
      updateConfig({ playDuration: value });
    },
    [apiConfig.playDuration, isConfigLoaded, updateConfig]
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

  const handleFloatingPlayerToggle = useCallback((enabled: boolean) => {
    if (!isConfigLoaded) {
      return;
    }
    if (enabled === apiConfig.floatingPlayerEnabled) {
      return;
    }
    updateConfig({ floatingPlayerEnabled: enabled });
  }, [apiConfig.floatingPlayerEnabled, isConfigLoaded, updateConfig]);

  if (!isConfigLoaded) {
    return <PageLoading message="页面加载中..." />;
  }

  return (
    <div className={styles.configPage}>
      <div className={styles.configForm}>
        <ThemeModeSection value={themeMode} onChange={setThemeMode} />
        <BasicConfigSection
          playDuration={playDuration}
          onPlayDurationChange={handlePlayDurationChange}
        />
        <FloatingPlayerSection
          value={isFloatingPlayerEnabled}
          onChange={handleFloatingPlayerToggle}
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
