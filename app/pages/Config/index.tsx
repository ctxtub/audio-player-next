import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Form, Button, Toast } from 'antd-mobile';

import styles from './index.module.scss';
import { trackEvent } from '../../utils/analytics';
import { PageLoading } from '@/components/PageLoading';
import { useConfigStore } from '@/stores/configStore';
import BasicConfigSection from './components/BasicConfigSection';
import VoiceServiceSection from './components/VoiceServiceSection';
import ThemeModeSection from './components/ThemeModeSection';
import type { APIConfig } from '@/types/types';
import type { ConfigFormValues } from './components/types';
import type { TtsVoiceOption } from '@/types/tts';
import { fetchAudio, TtsApiClientError } from '@/lib/client/ttsGenerate';
import { fetchAppConfig, AppConfigClientError } from '@/lib/client/appConfig';

/**
 * 尝试将输入转换为合法的数字。
 * @param value 表单输入值。
 * @param fallback 转换失败时返回的默认值。
 */
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

/**
 * 将表单结果与现有配置合并，输出标准化配置。
 * @param values 表单提交值。
 * @param baseConfig 当前配置。
 */
const normalizeFormValues = (values: ConfigFormValues, baseConfig: APIConfig): APIConfig => {
  const playDuration = ensureNumber(values.playDuration, baseConfig.playDuration);
  const voiceName =
    typeof values.voiceName === 'string' && values.voiceName.trim()
      ? values.voiceName.trim()
      : baseConfig.voiceName;

  return {
    ...baseConfig,
    playDuration,
    voiceName,
  };
};

/**
 * 配置页：管理播放时长与默认语音等偏好。
 */
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

  const [voiceOptions, setVoiceOptions] = useState<TtsVoiceOption[]>([]);
  const [isVoiceLoading, setIsVoiceLoading] = useState<boolean>(false);

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
    let isMounted = true;

    const loadVoices = async () => {
      setIsVoiceLoading(true);
      try {
        const config = await fetchAppConfig();
        if (!isMounted) {
          return;
        }

        const fetchedVoices = config.tts.voices;
        setVoiceOptions(fetchedVoices);

        const currentVoice = form.getFieldValue('voiceName') as string | undefined;
        const envDefaultVoice = config.tts.defaultVoice;
        const resolvedVoice =
          currentVoice && fetchedVoices.some(voice => voice.value === currentVoice)
            ? currentVoice
            : envDefaultVoice ?? config.defaults.voiceName;
        form.setFieldValue('voiceName', resolvedVoice);
      } catch (error) {
        if (!isMounted) {
          return;
        }

        const message =
          error instanceof AppConfigClientError ? error.message : '配置加载失败，请重试';
        Toast.show({ icon: 'fail', content: message, duration: 3000 });
        setVoiceOptions([]);
      } finally {
        if (isMounted) {
          setIsVoiceLoading(false);
        }
      }
    };

    loadVoices();

    return () => {
      isMounted = false;
    };
  }, [form]);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  /**
   * 选中语音时停止其他试听，保证状态一致。
   */
  const handleVoiceSelect = useCallback((voice: string) => {
    setPlayingVoice(prev => {
      if (prev && prev !== voice && audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      return prev === voice ? prev : null;
    });
  }, []);

  /**
   * 请求并播放语音试听。
   * @param voice 选中的语音名称。
   */
  const handlePreview = useCallback(
    async (voice: string) => {
      let objectUrl: string | null = null;
      try {
        setPlayingVoice(voice);
        const previewText = '你好，让我为你讲故事吧';
        objectUrl = await fetchAudio(previewText, voice);

        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current = null;
        }

        const audio = new Audio(objectUrl);
        audioRef.current = audio;

        const cleanup = () => {
          setPlayingVoice(null);
          audioRef.current = null;
          if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
          }
        };

        audio.addEventListener('ended', cleanup, { once: true });

        audio.addEventListener(
          'error',
          (event) => {
            cleanup();
            const errorMessage =
              (event as ErrorEvent).error?.message || '音频播放失败，请重试';
            Toast.show({ icon: 'fail', content: errorMessage, duration: 3000 });
          },
          { once: true }
        );

        await audio.play();
      } catch (error) {
        console.error('试听失败:', error);
        setPlayingVoice(null);
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
        const message = error instanceof Error ? error.message : String(error);
        Toast.show({ icon: 'fail', content: message, duration: 3000 });
      }
    },
    []
  );

  /**
   * 表单提交时校验并保存配置。
   * @param values 表单数据。
   */
  const handleFinish = useCallback(
    async (values: ConfigFormValues) => {
      const normalized = normalizeFormValues(values, apiConfig);

      if (!normalized.playDuration || normalized.playDuration <= 0) {
        Toast.show({ icon: 'fail', content: '请输入有效的播放时长', duration: 3000 });
        return;
      }

      if (!normalized.voiceName?.trim()) {
        Toast.show({ icon: 'fail', content: '请选择一个声音', duration: 3000 });
        return;
      }

      if (!voiceOptions.some(option => option.value === normalized.voiceName)) {
        Toast.show({ icon: 'fail', content: '所选声音已不可用，请重新选择', duration: 3000 });
        return;
      }

      try {
        updateConfig(normalized);
        trackEvent('config_saved', 'config', normalized.voiceName);
        Toast.show({ icon: 'success', content: '配置已保存', duration: 3000 });

        setTimeout(() => {
          router.push('/');
        }, 1000);
      } catch (error) {
        console.error('Error saving config:', error);
        Toast.show({ icon: 'fail', content: '保存配置失败，请重试', duration: 3000 });
        trackEvent('config_error', 'error', 'save_failed');
      }
    },
    [apiConfig, router, updateConfig, voiceOptions]
  );

  /**
   * 表单校验失败时提示用户补全信息。
   */
  const handleFinishFailed = useCallback(() => {
    Toast.show({ icon: 'fail', content: '请检查表单字段是否填写完整', duration: 3000 });
  }, []);

  if (!isConfigLoaded) {
    return <PageLoading message="页面加载中..." />;
  }

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
        <BasicConfigSection />
      <VoiceServiceSection
        form={form}
        voices={voiceOptions}
        playingVoice={playingVoice}
        isLoading={isVoiceLoading}
          onVoiceSelect={handleVoiceSelect}
          onPreview={handlePreview}
        />
        <Form.Item className={styles.submitItem}>
          <Button
            className={styles.submitButton}
            color="primary"
            block
            onClick={() => form.submit()}
            disabled={isVoiceLoading || voiceOptions.length === 0}
          >
            保存配置
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
};

export default ConfigPage;
