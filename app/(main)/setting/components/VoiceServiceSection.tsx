import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Selector, Toast } from 'antd-mobile';

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

  const selectorValue = value ? [value] : [];

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

  const handleSelectorChange = useCallback(
    (values: string[]) => {
      const [nextVoice] = values;
      if (!nextVoice || nextVoice === value) {
        return;
      }
      onChange(nextVoice);
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
        Toast.show({ icon: 'fail', content: '所选声音已不可用，请重新选择', duration: 3000 });
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
            Toast.show({ icon: 'fail', content: errorMessage, duration: 3000 });
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
        Toast.show({ icon: 'fail', content: message, duration: 3000 });
      }
    },
    [playingVoice, stopPreview, voicesList],
  );

  return (
    <div className={styles.configSection}>
      <h3>语音音色</h3>
      {hasVoices ? (
        <div className={styles.voiceSelectorWrapper}>
          <Selector
            className={styles.voiceSelector}
            columns={1}
            multiple={false}
            value={selectorValue}
            onChange={handleSelectorChange}
            options={voicesList.map(option => {
              const isPlaying = playingVoice === option.value;
              return {
                value: option.value,
                label: (
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
                    <Button
                      className={styles.voicePreviewButton}
                      size="mini"
                      color="primary"
                      fill="outline"
                      onClick={event => {
                        event.stopPropagation();
                        void handlePreview(option.value);
                      }}
                      loading={isPlaying}
                      disabled={playingVoice !== null && !isPlaying}
                    >
                      {isPlaying ? '试听中' : '试听'}
                    </Button>
                  </div>
                ),
              };
            })}
          />
        </div>
      ) : (
        <div className={styles.voiceEmptyState}>
          暂无可用声音，请联系管理员配置 OPENAI_TTS_VOICE_LIST。
        </div>
      )}
    </div>
  );
};

export default VoiceServiceSection;
