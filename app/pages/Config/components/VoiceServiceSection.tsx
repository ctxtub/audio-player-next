import React from 'react';
import { Form, Input, Selector } from 'antd-mobile';
import type { FormInstance } from 'antd-mobile';
import type { VoiceProvider } from '@/types/types';
import { AZURE_VOICE_GROUPS, MS_VOICE_GROUPS } from '../../../config/voices';
import { AZURE_REGIONS } from '../../../config/regions';
import styles from '../index.module.scss';
import VoiceOptionList from './VoiceOptionList';
import type { ConfigFormValues, ProviderOption, VoiceGroups } from './types';

const PROVIDER_OPTIONS: ProviderOption[] = [
  { label: 'Free TTS', value: 'free-tts' },
  { label: 'Azure TTS', value: 'azure-tts' },
];

interface VoiceServiceSectionProps {
  form: FormInstance<ConfigFormValues>;
  playingVoice: string | null;
  onProviderSelect: (provider: VoiceProvider) => void;
  onVoiceSelect: (voice: string, provider: VoiceProvider) => void;
  onPreview: (voice: string, provider: VoiceProvider) => void;
}

const VoiceServiceSection: React.FC<VoiceServiceSectionProps> = ({
  form,
  playingVoice,
  onProviderSelect,
  onVoiceSelect,
  onPreview,
}) => {
  const voiceProvider = Form.useWatch('voiceProvider', form) as VoiceProvider | undefined;
  const selectedFreeVoice = Form.useWatch(['freeTtsConfig', 'voiceName'], form) as string | undefined;
  const selectedAzureVoice = Form.useWatch(['azureTtsConfig', 'voiceName'], form) as string | undefined;
  const azureRegion = Form.useWatch(['azureTtsConfig', 'speechRegion'], form) as string | undefined;

  const handleProviderChange = (values: string[]) => {
    if (!values.length) {
      return;
    }
    const nextProvider = values[0] as VoiceProvider;
    form.setFieldValue('voiceProvider', nextProvider);
    onProviderSelect(nextProvider);
  };

  return (
    <div className={styles.configSection}>
      <h3>语音服务</h3>

      <Form.Item
        name="voiceProvider"
        label="语音服务提供商"
        rules={[{ required: true, message: '请选择语音服务提供商' }]}
      >
        <Selector
          options={PROVIDER_OPTIONS}
          columns={PROVIDER_OPTIONS.length}
          value={voiceProvider ? [voiceProvider] : []}
          onChange={handleProviderChange}
        />
      </Form.Item>

      {voiceProvider === 'free-tts' ? (
        <VoiceOptionList
          groups={MS_VOICE_GROUPS as VoiceGroups}
          provider="free-tts"
          selectedVoice={selectedFreeVoice}
          playingVoice={playingVoice}
          onSelect={onVoiceSelect}
          onPreview={onPreview}
        />
      ) : (
        <>
          <Form.Item
            name={['azureTtsConfig', 'speechKey']}
            label="Azure Speech Key"
            rules={[{ required: true, message: '请输入 Azure Speech Key' }]}
          >
            <Input type="password" placeholder="输入你的 Azure Speech Key" clearable />
          </Form.Item>

          <Form.Item
            name={['azureTtsConfig', 'speechRegion']}
            label="Azure Region"
            rules={[{ required: true, message: '请选择 Azure Region' }]}
          >
            <Selector
              options={AZURE_REGIONS.map(region => ({
                label: `${region.label} · ${region.description}`,
                value: region.value,
              }))}
              columns={2}
              value={azureRegion ? [azureRegion] : []}
              onChange={values => {
                if (!values.length) {
                  return;
                }
                const [regionValue] = values;
                form.setFieldValue(['azureTtsConfig', 'speechRegion'], regionValue);
              }}
            />
          </Form.Item>

          <VoiceOptionList
            groups={AZURE_VOICE_GROUPS as VoiceGroups}
            provider="azure-tts"
            selectedVoice={selectedAzureVoice}
            playingVoice={playingVoice}
            onSelect={onVoiceSelect}
            onPreview={onPreview}
          />
        </>
      )}
    </div>
  );
};

export default VoiceServiceSection;
