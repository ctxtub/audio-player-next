import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import GlassToast from '@/components/ui/GlassToast';
import { RadioGroup, Radio } from 'react-aria-components';

import GlassButton from '@/components/ui/GlassButton';
import styles from '../index.module.scss';
import type { VoiceOption } from '@/types/ttsGenerate';
import { fetchAudio } from '@/lib/client/ttsGenerate';

/**
 * 语音音色配置模块的入参。
 */
interface VoiceServiceSectionProps {
  value?: string;
  voicesList: VoiceOption[];
  onChange: (voice: string) => void;
}

/**
 * 语音音色配置模块，支持选择声音并试听。
 */
const VoiceServiceSection: React.FC<VoiceServiceSectionProps> = ({
  value,
  voicesList,
  onChange,
}) => {
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const stopPreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPlayingVoice(null);
  }, []);

  useEffect(() => () => stopPreview(), [stopPreview]);

  const hasVoices = useMemo(() => voicesList.length > 0, [voicesList]);

  useEffect(() => {
    if (playingVoice && !voicesList.some(option => option.value === playingVoice)) {
      stopPreview();
    }
  }, [playingVoice, stopPreview, voicesList]);

  const handleChange = useCallback(
    (nextVoice: string) => {
      if (nextVoice && nextVoice !== value) {
        onChange(nextVoice);
      }
    },
    [onChange, value],
  );

  const handlePreview = useCallback(
    async (voice: string) => {
      if (!voice || playingVoice === voice) {
        stopPreview();
        return;
      }

      if (!voicesList.some(option => option.value === voice)) {
        GlassToast.show({ icon: 'fail', content: '所选声音已不可用，请重新选择', duration: 3000 });
        return;
      }

      stopPreview();

      let objectUrl: string | null = null;
      try {
        setPlayingVoice(voice);
        const previewText = '你好，让我为你讲故事吧';
        objectUrl = await fetchAudio(previewText, voice);
        previewUrlRef.current = objectUrl;

        const audio = new Audio(objectUrl);
        audioRef.current = audio;

        audio.addEventListener('ended', stopPreview, { once: true });
        audio.addEventListener(
          'error',
          event => {
            const errorMessage =
              (event as ErrorEvent).error?.message || '音频播放失败，请重试';
            stopPreview();
            GlassToast.show({ icon: 'fail', content: errorMessage, duration: 3000 });
          },
          { once: true }
        );

        await audio.play();
      } catch (error) {
        console.error('试听失败:', error);
        stopPreview();
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
        const message = error instanceof Error ? error.message : String(error);
        GlassToast.show({ icon: 'fail', content: message, duration: 3000 });
      }
    },
    [playingVoice, stopPreview, voicesList],
  );

  return (
    <div className={styles.configSection}>
      <h3>语音音色</h3>
      {hasVoices ? (
        <RadioGroup
          value={value ?? ''}
          onChange={handleChange}
          className={styles.voiceSelectorWrapper}
          aria-label="语音音色选择"
        >
          {voicesList.map(option => {
            const isPlaying = playingVoice === option.value;
            return (
              <Radio
                key={option.value}
                value={option.value}
                className={({ isSelected }) =>
                  `${styles.voiceRadioItem} ${isSelected ? styles.voiceRadioSelected : ''}`
                }
              >
                <div className={styles.voiceSelectorOption}>
                  <div className={styles.voiceSelectorInfo}>
                    <div className={styles.voiceSelectorName}>
                      {option.label}
                    </div>
                    <div className={styles.voiceDescription}>
                      <div>{option.description ?? '暂无描述'}</div>
                      <div className={styles.voiceMeta}>
                        {(option.gender ?? '未知')} ·{' '}
                        {(option.locale ?? '未知')}
                      </div>
                    </div>
                  </div>
                  <GlassButton
                    variant="outline"
                    size="sm"
                    loading={isPlaying}
                    isDisabled={playingVoice !== null && !isPlaying}
                    onPress={(e) => {
                      e.continuePropagation();
                      void handlePreview(option.value);
                    }}
                  >
                    {isPlaying ? '试听中' : '试听'}
                  </GlassButton>
                </div>
              </Radio>
            );
          })}
        </RadioGroup>
      ) : (
        <div className={styles.voiceEmptyState}>
          暂无可用声音，请联系管理员配置 OPENAI_TTS_VOICE_LIST。
        </div>
      )}
    </div>
  );
};

export default VoiceServiceSection;
