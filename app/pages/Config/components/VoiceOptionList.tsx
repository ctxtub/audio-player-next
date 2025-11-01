import React from 'react';
import { Button, List, Radio } from 'antd-mobile';
import styles from '../index.module.scss';
import type { VoiceProvider } from '@/types/types';
import type { VoiceGroups } from './types';

interface VoiceOptionListProps {
  groups: VoiceGroups;
  provider: VoiceProvider;
  selectedVoice?: string;
  playingVoice: string | null;
  onSelect: (voice: string, provider: VoiceProvider) => void;
  onPreview: (voice: string, provider: VoiceProvider) => void;
}

const VoiceOptionList: React.FC<VoiceOptionListProps> = ({
  groups,
  provider,
  selectedVoice,
  playingVoice,
  onSelect,
  onPreview,
}) => (
  <Radio.Group
    value={selectedVoice}
    onChange={value => onSelect(value as string, provider)}
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
                  <div>{option.description}</div>
                  <div className={styles.voiceMeta}>{option.gender} · {option.locale}</div>
                </div>
              }
              extra={
                <Button
                  size="mini"
                  color="primary"
                  fill="outline"
                  onClick={(event) => {
                    event.stopPropagation();
                    onPreview(option.value, provider);
                  }}
                  loading={isPlaying}
                  disabled={playingVoice !== null && !isPlaying}
                >
                  {isPlaying ? '试听中' : '试听'}
                </Button>
              }
              onClick={() => onSelect(option.value, provider)}
            >
              {option.label}
            </List.Item>
          );
        })}
      </List>
    ))}
  </Radio.Group>
);

export default VoiceOptionList;
