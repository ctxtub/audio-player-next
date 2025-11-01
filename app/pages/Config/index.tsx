import React, { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Form, Button, Toast } from 'antd-mobile';
import { fetchAudio } from '../../api/chat';
import styles from './index.module.scss';
import { trackEvent } from '../../utils/analytics';
import type { APIConfig, VoiceProvider } from '@/types/types';
import { useConfigStore } from '@/stores/configStore';
import { PageLoading } from '@/components/PageLoading';
import BasicConfigSection from './components/BasicConfigSection';
import VoiceServiceSection from './components/VoiceServiceSection';
import ThemeModeSection from './components/ThemeModeSection';
import type { ConfigFormValues } from './components/types';

const ensureNumber = (value: number | string | undefined, fallback = 0): number => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
  }
  return fallback;
};

const normalizeFormValues = (values: ConfigFormValues, baseConfig: APIConfig): APIConfig => ({
  ...baseConfig,
  ...values,
  playDuration: ensureNumber(values.playDuration, baseConfig.playDuration),
  azureTtsConfig: {
    ...baseConfig.azureTtsConfig,
    ...(values.azureTtsConfig ?? {}),
  },
  freeTtsConfig: {
    ...baseConfig.freeTtsConfig,
    ...(values.freeTtsConfig ?? {}),
  },
});

const applyProviderDefaults = (config: APIConfig, provider: VoiceProvider): APIConfig => {
  if (provider === 'azure-tts') {
    return {
      ...config,
      azureTtsConfig: {
        ...config.azureTtsConfig,
        speechRegion: config.azureTtsConfig.speechRegion || 'eastasia',
        voiceName: config.azureTtsConfig.voiceName || 'zh-CN-XiaoxiaoNeural',
        speechKey: config.azureTtsConfig.speechKey || '',
      },
    };
  }

  return {
    ...config,
    freeTtsConfig: {
      ...config.freeTtsConfig,
      voiceName: config.freeTtsConfig.voiceName || 'zh-CN-XiaoxiaoNeural',
      speechKey: config.freeTtsConfig.speechKey || '',
    },
  };
};

const ConfigPage: React.FC = () => {
  const router = useRouter();
  const apiConfig = useConfigStore(state => state.apiConfig);
  const updateConfig = useConfigStore(state => state.update);
  const hydrateConfig = useConfigStore(state => state.hydrateFromStorage);
  const isConfigLoaded = useConfigStore(state => state.isLoaded);
  const loadError = useConfigStore(state => state.loadError);

  const [form] = Form.useForm<ConfigFormValues>();
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    hydrateConfig();
  }, [hydrateConfig]);

  useEffect(() => {
    if (loadError) {
      Toast.show({ icon: 'fail', content: '配置加载失败，已恢复默认设置', duration: 3000 });
    }
  }, [loadError]);

  useEffect(() => {
    if (isConfigLoaded) {
      form.setFieldsValue(apiConfig);
    }
  }, [apiConfig, form, isConfigLoaded]);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  if (!isConfigLoaded) {
    return <PageLoading message="页面加载中..." />;
  }

  const handleProviderSelect = (provider: VoiceProvider) => {
    const currentValues = form.getFieldsValue(true) as ConfigFormValues;
    const mergedConfig = normalizeFormValues(
      {
        ...currentValues,
        voiceProvider: provider,
      },
      apiConfig,
    );
    const withDefaults = applyProviderDefaults(mergedConfig, provider);

    form.setFieldsValue({
      voiceProvider: provider,
      azureTtsConfig: withDefaults.azureTtsConfig,
      freeTtsConfig: withDefaults.freeTtsConfig,
    });
  };

  const handleVoiceSelect = (voice: string, provider: VoiceProvider) => {
    const currentValues = form.getFieldsValue(true) as ConfigFormValues;
    if (provider === 'azure-tts') {
      form.setFieldsValue({
        azureTtsConfig: {
          ...(currentValues.azureTtsConfig ?? {}),
          voiceName: voice,
        },
      });
    } else {
      form.setFieldsValue({
        freeTtsConfig: {
          ...(currentValues.freeTtsConfig ?? {}),
          voiceName: voice,
        },
      });
    }
  };

  const handlePreview = async (voice: string, provider: VoiceProvider) => {
    try {
      setPlayingVoice(voice);
      const previewText = '你好，让我为你讲故事吧';
      const formValues = form.getFieldsValue(true) as ConfigFormValues;

      const previewConfig = applyProviderDefaults(
        normalizeFormValues(
          {
            ...formValues,
            voiceProvider: provider,
            azureTtsConfig: {
              ...(formValues.azureTtsConfig ?? {}),
              voiceName: provider === 'azure-tts' ? voice : formValues.azureTtsConfig?.voiceName ?? '',
            },
            freeTtsConfig: {
              ...(formValues.freeTtsConfig ?? {}),
              voiceName: provider === 'free-tts' ? voice : formValues.freeTtsConfig?.voiceName ?? '',
            },
          },
          apiConfig,
        ),
        provider,
      );

      const audioUrl = await fetchAudio(previewText, previewConfig);

      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }

      const audio = new Audio(audioUrl);
      audioRef.current = audio;

      audio.addEventListener('ended', () => {
        setPlayingVoice(null);
        audioRef.current = null;
      });

      audio.addEventListener('error', (e) => {
        setPlayingVoice(null);
        audioRef.current = null;
        const errorMessage = (e as ErrorEvent).error?.message || '音频播放失败，请重试';
        Toast.show({ icon: 'fail', content: errorMessage, duration: 3000 });
      });

      await audio.play();
    } catch (error) {
      console.error('试听失败:', error);
      setPlayingVoice(null);
      Toast.show({
        icon: 'fail',
        content: error instanceof Error ? error.message : String(error),
        duration: 3000,
      });
    }
  };

  const handleFinish = async (values: ConfigFormValues) => {
    const normalized = applyProviderDefaults(
      normalizeFormValues(values, apiConfig),
      (values.voiceProvider ?? apiConfig.voiceProvider) as VoiceProvider,
    );

    if (normalized.voiceProvider !== 'free-tts' && !normalized.apiKey.trim()) {
      Toast.show({ icon: 'fail', content: '请输入API密钥', duration: 3000 });
      return;
    }

    if (!normalized.playDuration || normalized.playDuration <= 0) {
      Toast.show({ icon: 'fail', content: '请输入有效的播放时长', duration: 3000 });
      return;
    }

    if (normalized.voiceProvider === 'azure-tts') {
      if (!normalized.azureTtsConfig?.speechKey?.trim()) {
        Toast.show({ icon: 'fail', content: '请输入 Azure Speech Key', duration: 3000 });
        return;
      }
      if (!normalized.azureTtsConfig?.speechRegion?.trim()) {
        Toast.show({ icon: 'fail', content: '请选择 Azure Region', duration: 3000 });
        return;
      }
      if (!normalized.azureTtsConfig?.voiceName?.trim()) {
        Toast.show({ icon: 'fail', content: '请选择 Azure 声音', duration: 3000 });
        return;
      }
    }

    if (normalized.voiceProvider === 'free-tts' && !normalized.freeTtsConfig?.voiceName?.trim()) {
      Toast.show({ icon: 'fail', content: '请选择 Free TTS 声音', duration: 3000 });
      return;
    }

    try {
      updateConfig(normalized);
      trackEvent('config_saved', 'config', normalized.voiceProvider);
      Toast.show({ icon: 'success', content: '配置已保存', duration: 3000 });

      setTimeout(() => {
        router.push('/');
      }, 1000);
    } catch (error) {
      console.error('Error saving config:', error);
      Toast.show({ icon: 'fail', content: '保存配置失败，请重试', duration: 3000 });
      trackEvent('config_error', 'error', 'save_failed');
    }
  };

  const handleFinishFailed = () => {
    Toast.show({ icon: 'fail', content: '请检查表单字段是否填写完整', duration: 3000 });
  };

  return (
    <div className={styles.configContainer}>
      <Form
        form={form}
        className={styles.configForm}
        layout="vertical"
        initialValues={apiConfig}
        onFinish={handleFinish}
        onFinishFailed={handleFinishFailed}
      >
        <ThemeModeSection />
        <BasicConfigSection form={form} />
        <VoiceServiceSection
          form={form}
          playingVoice={playingVoice}
          onProviderSelect={handleProviderSelect}
          onVoiceSelect={handleVoiceSelect}
          onPreview={handlePreview}
        />
        <Form.Item className={styles.submitItem}>
          <Button className={styles.submitButton} color="primary" block onClick={() => form.submit()}>
            保存配置
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
};

export default ConfigPage;
