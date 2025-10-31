import React, { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AZURE_VOICE_GROUPS } from '../../config/voices';
import { AZURE_REGIONS } from '../../config/regions';
import { MS_VOICE_GROUPS } from '../../config/voices';
import { Toast } from '../../../components/Toast';
import { fetchAudio } from '../../api/chat';
import PlayIcon from '@/public/icons/audioplayer-play.svg';
import PauseIcon from '@/public/icons/audioplayer-pause.svg';
import BackIcon from '@/public/icons/back-arrow.svg';
import styles from './index.module.scss';
import { trackEvent } from '../../utils/analytics';
import { AVAILABLE_MODELS } from '@/types/types';
import type { APIConfig, VoiceProvider, AzureRegion } from '@/types/types';
import { useConfigStore } from '@/stores/configStore';
import { PageLoading } from '@/components/PageLoading';

const ConfigPage: React.FC = () => {
  const router = useRouter();
  const apiConfig = useConfigStore(state => state.apiConfig);
  const updateConfig = useConfigStore(state => state.update);
  const hydrateConfig = useConfigStore(state => state.hydrateFromStorage);
  const isConfigLoaded = useConfigStore(state => state.isLoaded);
  const loadError = useConfigStore(state => state.loadError);

  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    hydrateConfig();
  }, [hydrateConfig]);

  useEffect(() => {
    if (loadError) {
      Toast({ message: '配置加载失败，已恢复默认设置' });
    }
  }, [loadError]);

  // 组件卸载时清理音频
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

  const handleProviderChange = (provider: VoiceProvider) => {
    if (provider === 'azure-tts') {
      handleAzureConfigChange({
        speechRegion: 'eastasia',
        voiceName: 'zh-CN-XiaoxiaoNeural'
      });
    } else if (provider === 'free-tts') {
      handleMsConfigChange({
        voiceName: 'zh-CN-XiaoxiaoNeural'
      });
    }
    handleVoiceProviderChange(provider);
  };

  const handlePreview = async (voice: string, provider: VoiceProvider) => {
    try {
      setPlayingVoice(voice);
      const previewText = "你好，让我为你讲故事吧";
      const previewConfig = {
        ...apiConfig,
        voiceProvider: provider,
        azureTtsConfig: {
          ...apiConfig.azureTtsConfig,
          voiceName: provider === 'azure-tts' ? voice : apiConfig.azureTtsConfig.voiceName
        },
        freeTtsConfig: {
          ...apiConfig.freeTtsConfig,
          voiceName: provider === 'free-tts' ? voice : apiConfig.freeTtsConfig.voiceName
        }
      };
      
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
        const errorMessage = e.error?.message || '音频播放失败，请重试';
        Toast({ message: errorMessage });
      });

      await audio.play();
    } catch (error) {
      console.error('试听失败:', error);
      setPlayingVoice(null);
      Toast({ message: error instanceof Error ? error.message : String(error) });
    }
  };

  const handleApiConfigChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.target;
    updateConfig({
      [name]: name === 'playDuration' ? parseInt(value, 10) || 0 : value,
    } as Partial<APIConfig>);
  };

  const handleAzureConfigChange = (config: Partial<APIConfig['azureTtsConfig']>) => {
    updateConfig({
      azureTtsConfig: {
        ...apiConfig.azureTtsConfig,
        ...config,
      },
    });
  };

  const handleVoiceProviderChange = (provider: VoiceProvider) => {
    updateConfig({ voiceProvider: provider });
  };

  const handleMsConfigChange = (freeTtsConfig: Partial<APIConfig['freeTtsConfig']>) => {
    updateConfig({
      freeTtsConfig: {
        ...apiConfig.freeTtsConfig,
        ...freeTtsConfig,
      },
    });
  };

  const handleModelChange = (type: 'storyModel' | 'summaryModel', value: string) => {
    updateConfig({ [type]: value } as Partial<APIConfig>);
  };

  const handleSubmit = async () => {
    // 只对非 MS 提供商验证 API 密钥
    if (apiConfig.voiceProvider !== 'free-tts' && !apiConfig.apiKey.trim()) {
      Toast({ message: '请输入API密钥' });
      return;
    }
    if (apiConfig.playDuration <= 0) {
      Toast({ message: '请输入有效的播放时长' });
      return;
    }

    // 只对 Azure 提供商验证额外配置
    if (apiConfig.voiceProvider === 'azure-tts') {
      if (!apiConfig.azureTtsConfig?.speechKey?.trim()) {
        Toast({ message: '请输入 Azure Speech Key' });
        return;
      }
      if (!apiConfig.azureTtsConfig?.speechRegion?.trim()) {
        Toast({ message: '请选择 Azure Region' });
        return;
      }
      if (!apiConfig.azureTtsConfig?.voiceName?.trim()) {
        Toast({ message: '请选择 Azure 声音' });
        return;
      }
    }

    // 对 MS TTS 验证语音选择
    if (apiConfig.voiceProvider === 'free-tts' && !apiConfig.freeTtsConfig?.voiceName?.trim()) {
      Toast({ message: '请选择 Free TTS 声音' });
      return;
    }

    try {
      trackEvent('config_saved', 'config', apiConfig.voiceProvider);
      Toast({ type: 'success', message: '配置已保存' });

      // 保存成功后导航回主页
      setTimeout(() => {
        router.push('/');
      }, 1000);
    } catch (error) {
      console.error('Error saving config:', error);
      Toast({ message: '保存配置失败，请重试' });
      trackEvent('config_error', 'error', 'save_failed');
    }
  };

  return (
    <div className={styles.configContainer}>
      <div className={styles.configHeader}>
        <div className={styles.headerLeft}>
          <button 
            type="button" 
            className={styles.backButton}
            onClick={() => router.push('/')}
            aria-label="返回"
          >
            <BackIcon className={styles.backIcon} />
          </button>
          <h1>配置API</h1>
        </div>
      </div>
      <form className={styles.configForm}>
        {/* 基础配置模块 */}
        <div className={styles.configSection}>
          <h3>基础配置</h3>
          <div className={styles.inputGroup}>
            <label htmlFor="apiKey">OpenAI API密钥</label>
            <input
              id="apiKey"
              type="password"
              name="apiKey"
              value={apiConfig.apiKey}
              onChange={handleApiConfigChange}
              placeholder="sk-..."
              required
            />
          </div>
          <div className={styles.inputGroup}>
            <label htmlFor="apiBaseUrl">API域名</label>
            <input
              id="apiBaseUrl"
              type="text"
              name="apiBaseUrl"
              value={apiConfig.apiBaseUrl}
              onChange={handleApiConfigChange}
              placeholder="https://api.openai.com"
            />
          </div>
          <div className={styles.inputGroup}>
            <label htmlFor="playDuration">播放时长（分钟）</label>
            <input
              id="playDuration"
              type="number"
              name="playDuration"
              value={apiConfig.playDuration}
              onChange={handleApiConfigChange}
              placeholder="30"
              min="1"
              required
            />
          </div>
          <div className={styles.inputGroup}>
            <label htmlFor="storyModel">故事生成模型</label>
            <select
              id="storyModel"
              name="storyModel"
              value={apiConfig.storyModel}
              onChange={(e) => handleModelChange('storyModel', e.target.value)}
            >
              {AVAILABLE_MODELS.STORY_MODELS.map(model => (
                <option key={model.value} value={model.value}>
                  {model.label}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.inputGroup}>
            <label htmlFor="summaryModel">摘要生成模型</label>
            <select
              id="summaryModel"
              name="summaryModel"
              value={apiConfig.summaryModel}
              onChange={(e) => handleModelChange('summaryModel', e.target.value)}
            >
              {AVAILABLE_MODELS.SUMMARY_MODELS.map(model => (
                <option key={model.value} value={model.value}>
                  {model.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 语音服务模块 */}
        <div className={styles.configSection}>
          <h3>语音服务</h3>
          <div className={styles.inputGroup}>
            <label>语音服务提供商</label>
            <div className={styles.providerOptions}>
              <button
                type="button"
                className={`${styles.providerOption} ${apiConfig.voiceProvider === 'free-tts' ? styles.selected : ''}`}
                onClick={() => handleProviderChange('free-tts')}
              >
                Free TTS
              </button>
              <button
                type="button"
                className={`${styles.providerOption} ${apiConfig.voiceProvider === 'azure-tts' ? styles.selected : ''}`}
                onClick={() => handleProviderChange('azure-tts')}
              >
                Azure TTS
              </button>
            </div>
          </div>
          {apiConfig.voiceProvider === 'free-tts' ? (
            <div className={styles.inputGroup}>
              {Object.entries(MS_VOICE_GROUPS).map(([locale, group]) => (
                <div key={locale} className={styles.voiceGroup}>
                  <h4 className={styles.voiceGroupTitle}>{group.label}</h4>
                  <div className={styles.voiceOptions}>
                    {group.voices.map(option => (
                      <div
                        key={option.value}
                        className={`${styles.voiceOption} ${apiConfig.freeTtsConfig?.voiceName === option.value ? styles.selected : ''}`}
                      >
                        <div className={styles.voiceContent} onClick={() => handleMsConfigChange({ voiceName: option.value })}>
                          <h3>{option.label}</h3>
                          <p>{option.description}</p>
                          <small>{option.gender} - {option.locale}</small>
                        </div>
                        <button 
                          type="button"
                          className={`${styles.previewButton} ${playingVoice === option.value ? styles.loading : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (playingVoice !== option.value) {
                              handlePreview(option.value, 'free-tts');
                            }
                          }}
                          disabled={playingVoice !== null}
                          aria-label={playingVoice === option.value ? "播放中" : "试听"}
                        >
                          {playingVoice === option.value ? <PauseIcon className={styles.icon} /> : <PlayIcon className={styles.icon} />}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className={styles.inputGroup}>
                <label htmlFor="speechKey">Azure Speech Key</label>
                <input
                  id="speechKey"
                  type="password"
                  name="speechKey"
                  value={apiConfig.azureTtsConfig?.speechKey || ''}
                  onChange={(e) => handleAzureConfigChange({ speechKey: e.target.value })}
                  placeholder="输入你的 Azure Speech Key"
                  required
                />
              </div>
              <div className={styles.inputGroup}>
                <label htmlFor="speechRegion">Azure Region</label>
                <select
                  id="speechRegion"
                  name="speechRegion"
                  value={apiConfig.azureTtsConfig?.speechRegion || ''}
                  onChange={(e) => handleAzureConfigChange({ speechRegion: e.target.value as AzureRegion })}
                  required
                >
                  <option value="">请选择区域</option>
                  {AZURE_REGIONS.map(region => (
                    <option key={region.value} value={region.value}>
                      {region.label} - {region.description}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.inputGroup}>
                <label>Azure 声音选择</label>
                {Object.entries(AZURE_VOICE_GROUPS).map(([locale, group]) => (
                  <div key={locale} className={styles.voiceGroup}>
                    <h4 className={styles.voiceGroupTitle}>{group.label}</h4>
                    <div className={styles.voiceOptions}>
                      {group.voices.map(option => (
                        <div
                          key={option.value}
                          className={`${styles.voiceOption} ${apiConfig.azureTtsConfig?.voiceName === option.value ? styles.selected : ''}`}
                        >
                          <div className={styles.voiceContent} onClick={() => handleAzureConfigChange({ voiceName: option.value })}>
                            <h3>{option.label}</h3>
                            <p>{option.description}</p>
                            <small>{option.gender} - {option.locale}</small>
                          </div>
                          <button 
                            type="button"
                            className={`${styles.previewButton} ${playingVoice === option.value ? styles.loading : ''}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (playingVoice !== option.value) {
                                handlePreview(option.value, 'azure-tts');
                              }
                            }}
                            disabled={playingVoice !== null}
                            aria-label={playingVoice === option.value ? "播放中" : "试听"}
                          >
                            {playingVoice === option.value ? <PauseIcon className={styles.icon} /> : <PlayIcon className={styles.icon} />}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </form>
      <div className={styles.submitContainer}>
          <button onClick={() => handleSubmit()}>保存配置</button>
      </div>
    </div>
  );
};

export default ConfigPage;
