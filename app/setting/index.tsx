import React, { useCallback, useEffect, useState } from 'react';

import styles from './index.module.scss';
import { PageLoading } from '@/components/PageLoading';
import { useConfigStore } from '@/stores/configStore';
import BasicConfigSection from './components/BasicConfigSection';
import VoiceServiceSection from './components/VoiceServiceSection';
import ThemeModeSection from './components/ThemeModeSection';
import { useTheme } from '@/components/ThemeProvider';

/**
 * 设置页面组件，承载播放配置与主题切换。
 * @returns 设置页 JSX 结构
 */
const ConfigPage: React.FC = () => {
  const apiConfig = useConfigStore(state => state.apiConfig);
  const updateConfig = useConfigStore(state => state.update);
  const initializeConfig = useConfigStore(state => state.initialize);
  const isConfigLoaded = useConfigStore(state => state.isLoaded);
  const voiceOptions = useConfigStore(state => state.voiceOptions);
  const { themeMode, setThemeMode } = useTheme();

  const [selectedVoice, setSelectedVoice] = useState<string | undefined>();
  const [playDuration, setPlayDuration] = useState<number>(0);

  useEffect(() => {
    initializeConfig().catch(() => {});
  }, [initializeConfig]);

  useEffect(() => {
    if (!isConfigLoaded) {
      return;
    }
    setPlayDuration(apiConfig.playDuration);
    setSelectedVoice(apiConfig.voiceId ?? undefined);
  }, [apiConfig.playDuration, apiConfig.voiceId, isConfigLoaded]);

  useEffect(() => {
    if (!isConfigLoaded) {
      return;
    }
    if (playDuration !== apiConfig.playDuration) {
      updateConfig({ playDuration });
    }
  }, [apiConfig.playDuration, isConfigLoaded, playDuration, updateConfig]);

  useEffect(() => {
    if (!isConfigLoaded) {
      return;
    }

    if (!selectedVoice) {
      const fallback = voiceOptions.find(option => option.value === apiConfig.voiceId)?.value;
      if (fallback) {
        setSelectedVoice(fallback);
      } else if (voiceOptions[0]) {
        setSelectedVoice(voiceOptions[0].value);
      }
      return;
    }
    const isVoiceValid = voiceOptions.some(option => option.value === selectedVoice);
    if (!isVoiceValid) {
      if (voiceOptions.length === 0) {
        if (selectedVoice !== undefined) {
          setSelectedVoice(undefined);
        }
      } else {
        const fallbackVoice = voiceOptions[0]?.value;
        if (fallbackVoice && fallbackVoice !== selectedVoice) {
          setSelectedVoice(fallbackVoice);
        }
      }
      return;
    }
    if (selectedVoice !== apiConfig.voiceId) {
      updateConfig({ voiceId: selectedVoice });
    }
  }, [apiConfig.voiceId, isConfigLoaded, selectedVoice, updateConfig, voiceOptions]);

  const handlePlayDurationChange = useCallback((value: number) => {
    setPlayDuration(value);
  }, []);

  const handleVoiceSelect = useCallback(
    (voice: string) => {
      if (!voice || voice === selectedVoice) {
        return;
      }

      const isVoiceValid = voiceOptions.some(option => option.value === voice);
      if (!isVoiceValid) {
        return;
      }

      setSelectedVoice(voice);
    },
    [selectedVoice, voiceOptions]
  );

  if (!isConfigLoaded) {
    return <PageLoading message="页面加载中..." />;
  }

  return (
    <div className={styles.configContainer}>
      <div className={styles.configForm}>
        <ThemeModeSection value={themeMode} onChange={setThemeMode} />
        <BasicConfigSection
          playDuration={playDuration}
          onPlayDurationChange={handlePlayDurationChange}
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
