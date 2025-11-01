import React from 'react';
import { Form, Input, Selector } from 'antd-mobile';
import type { FormInstance } from 'antd-mobile';
import { AVAILABLE_MODELS } from '@/types/types';
import type { VoiceProvider } from '@/types/types';
import styles from '../index.module.scss';
import type { ConfigFormValues } from './types';

interface BasicConfigSectionProps {
  form: FormInstance<ConfigFormValues>;
}

const parsePositiveInteger = (value: number | string | undefined): number => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
};

const BasicConfigSection: React.FC<BasicConfigSectionProps> = ({ form }) => {
  const voiceProvider = Form.useWatch('voiceProvider', form) as VoiceProvider | undefined;

  const storyModel = Form.useWatch('storyModel', form) as string | undefined;
  const summaryModel = Form.useWatch('summaryModel', form) as string | undefined;

  const handleSelectorChange = (field: keyof ConfigFormValues, values: string[]) => {
    const [nextValue] = values;
    form.setFieldValue(field, nextValue ?? '');
  };

  return (
    <div className={styles.configSection}>
      <h3>基础配置</h3>

      <Form.Item
        name="apiKey"
        label="OpenAI API密钥"
        dependencies={['voiceProvider']}
        rules={[
          {
            validator: (_, value) => {
              if (voiceProvider !== 'free-tts' && !value?.trim()) {
                return Promise.reject(new Error('请输入API密钥'));
              }
              return Promise.resolve();
            },
          },
        ]}
      >
        <Input type="password" placeholder="sk-..." clearable />
      </Form.Item>

      <Form.Item name="apiBaseUrl" label="API域名">
        <Input type="text" placeholder="https://api.openai.com" clearable />
      </Form.Item>

      <Form.Item
        name="playDuration"
        label="播放时长（分钟）"
        rules={[
          { required: true, message: '请输入播放时长' },
          {
            validator: (_, value) => {
              const parsed = parsePositiveInteger(value);
              if (parsed <= 0) {
                return Promise.reject(new Error('请输入有效的播放时长'));
              }
              return Promise.resolve();
            },
          },
        ]}
      >
        <Input type="number" placeholder="30" min={1} />
      </Form.Item>

      <Form.Item name="storyModel" label="故事生成模型">
        <Selector
          options={AVAILABLE_MODELS.STORY_MODELS}
          columns={1}
          value={storyModel ? [storyModel] : []}
          onChange={values => handleSelectorChange('storyModel', values)}
        />
      </Form.Item>

      <Form.Item name="summaryModel" label="摘要生成模型">
        <Selector
          options={AVAILABLE_MODELS.SUMMARY_MODELS}
          columns={1}
          value={summaryModel ? [summaryModel] : []}
          onChange={values => handleSelectorChange('summaryModel', values)}
        />
      </Form.Item>
    </div>
  );
};

export default BasicConfigSection;
