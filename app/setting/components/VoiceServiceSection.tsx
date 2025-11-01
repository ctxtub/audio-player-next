import React, { useMemo } from 'react';
import { Form } from 'antd-mobile';
import type { FormInstance } from 'antd-mobile';

import styles from '../index.module.scss';
import VoiceOptionList from './VoiceOptionList';
import type { ConfigFormValues, VoiceGroups } from './types';
import type { TtsVoiceOption } from '@/types/tts';

/**
 * 语音配置区域的 props。
 */
interface VoiceServiceSectionProps {
  form: FormInstance<ConfigFormValues>;
  voices: TtsVoiceOption[];
  playingVoice: string | null;
  isLoading?: boolean;
  onVoiceSelect: (voice: string) => void;
  onPreview: (voice: string) => void;
}

/**
 * 根据 locale 聚合语音列表，供列表展示。
 * @param voices 服务端返回的语音数组。
 */
const buildVoiceGroups = (voices: TtsVoiceOption[]): VoiceGroups => {
  return voices.reduce<VoiceGroups>((groups, voice) => {
    const locale = voice.locale ?? '其他';
    if (!groups[locale]) {
      groups[locale] = {
        label: locale,
        voices: [],
      };
    }
    groups[locale].voices.push(voice);
    return groups;
  }, {});
};

/**
 * 语音配置区域：展示语音列表并支持试听。
 */
const VoiceServiceSection: React.FC<VoiceServiceSectionProps> = ({
  form,
  voices,
  playingVoice,
  isLoading = false,
  onVoiceSelect,
  onPreview,
}) => {
  const voiceName = Form.useWatch('voiceName', form) as string | undefined;

  const voiceGroups = useMemo(() => buildVoiceGroups(voices), [voices]);

  const handleVoiceChange = (value: string) => {
    form.setFieldValue('voiceName', value);
    onVoiceSelect(value);
  };

  const hasVoices = voices.length > 0;

  return (
    <div className={styles.configSection}>
      <h3>语音服务</h3>
      {hasVoices ? (
        <Form.Item
          name="voiceName"
          label="可选声音"
          rules={[{ required: true, message: '请选择一个声音' }]}
        >
          <VoiceOptionList
            groups={voiceGroups}
            value={voiceName}
            playingVoice={playingVoice}
            onChange={handleVoiceChange}
            onPreview={onPreview}
          />
        </Form.Item>
      ) : (
        <div className={styles.voiceEmptyState}>
          {isLoading
            ? '声音列表加载中，请稍候…'
            : '暂无可用声音，请联系管理员配置 AZURE_TTS_VOICE_ALLOW_LIST。'}
        </div>
      )}
    </div>
  );
};

export default VoiceServiceSection;
