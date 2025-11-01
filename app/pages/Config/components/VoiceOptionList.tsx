import React from 'react';
import { Button, List, Radio } from 'antd-mobile';
import styles from '../index.module.scss';
import type { VoiceGroups } from './types';

/**
 * 语音列表渲染组件的 props。
 */
interface VoiceOptionListProps {
  groups: VoiceGroups;
  value?: string;
  playingVoice: string | null;
  onChange?: (voice: string) => void;
  onPreview: (voice: string) => void;
}

/**
 * 按语言分组展示语音列表，并支持试听与选中。
 */
const VoiceOptionList: React.FC<VoiceOptionListProps> = ({
  groups,
  value,
  playingVoice,
  onChange,
  onPreview,
}) => {
  const handleChange = (nextValue: string) => {
    if (onChange) {
      onChange(nextValue);
    }
  };

  return (
    <Radio.Group
      value={value}
      onChange={selected => handleChange(selected as string)}
    >
      {Object.entries(groups).map(([locale, group]) => (
        <List
          key={locale}
          header={<div className={styles.voiceGroupTitle}>{group.label}</div>}
          className={styles.voiceList}
          mode="card"
        >
          {group.voices.map(option => {
            const isPlaying = playingVoice === option.value;

            return (
              <List.Item
                key={option.value}
                prefix={<Radio value={option.value} />}
                description={
                  <div className={styles.voiceDescription}>
                    <div>{option.description ?? '暂无描述'}</div>
                    <div className={styles.voiceMeta}>
                      {(option.gender ?? '未知')} · {(option.locale ?? '未知')}
                    </div>
                  </div>
                }
                extra={
                  <Button
                    size="mini"
                    color="primary"
                    fill="outline"
                    onClick={(event) => {
                      event.stopPropagation();
                      onPreview(option.value);
                    }}
                    loading={isPlaying}
                    disabled={playingVoice !== null && !isPlaying}
                  >
                    {isPlaying ? '试听中' : '试听'}
                  </Button>
                }
                onClick={() => handleChange(option.value)}
              >
                {option.label}
              </List.Item>
            );
          })}
        </List>
      ))}
    </Radio.Group>
  );
};

export default VoiceOptionList;
