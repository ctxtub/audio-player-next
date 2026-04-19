'use client';

import React, { useEffect, useRef, useState } from 'react';
import { CSSTransition } from 'react-transition-group';
import { Play, Pause, SkipForward } from 'lucide-react';
import GlassToast from '@/components/ui/GlassToast';
import { usePlaybackStore, useFloatingPlayer } from '@/stores/playbackStore';
import { useChatStore } from '@/stores/chatStore';
import { useConfigStore } from '@/stores/configStore';
import styles from './index.module.scss';

/**
 * 可选的播放速度列表，按按钮顺序显示。
 */
const PLAYBACK_RATES = [
  { value: 0.8, label: '0.8x' },
  { value: 0.9, label: '0.9x' },
  { value: 0.95, label: '0.95x' },
  { value: 1, label: '1x' },
  { value: 1.05, label: '1.05x' },
  { value: 1.1, label: '1.1x' },
  { value: 1.5, label: '1.5x' },
] as const;

/**
 * 播放器页面的音频控制组件，展示唱片动画、曲目信息、进度与倍速控制。
 * @returns JSX.Element 播放器 UI
 */
const AudioPlayer: React.FC = () => {
  const speedMenuRef = useRef<HTMLDivElement>(null);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const playbackRate = usePlaybackStore((state) => state.playbackRate);
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const duration = usePlaybackStore((state) => state.duration);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const seekAudio = usePlaybackStore((state) => state.seekAudio);
  const setGlobalPlaybackRate = usePlaybackStore((state) => state.setPlaybackRate);
  const { resume, pause } = useFloatingPlayer();

  /* 曲目信息：从最后一条用户消息和当前语音选项推导 */
  const messages = useChatStore((state) => state.messages);
  const voiceOptions = useConfigStore((state) => state.voiceOptions);
  const voiceId = useConfigStore((state) => state.apiConfig.voiceId);
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const trackTitle = lastUserMsg ? lastUserMsg.content.slice(0, 20) : '音频故事';
  const selectedVoice = voiceOptions.find((v) => v.value === voiceId);
  const trackSub = selectedVoice ? selectedVoice.label : 'AI 语音';

  const hasAudio = duration > 0;
  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (showSpeedMenu) {
        const target = event.target as HTMLElement;
        if (!target.closest(`.${styles.speedControl}`)) {
          setShowSpeedMenu(false);
        }
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [showSpeedMenu]);

  const formatTime = (time: number): string => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const togglePlay = () => {
    if (!hasAudio) {
      return;
    }
    if (isPlaying) {
      pause();
    } else {
      resume().catch((error) => {
        const message = error instanceof Error ? error.message : '无法恢复播放';
        GlassToast.show({ icon: 'fail', content: message, duration: 3000 });
      });
    }
  };

  const handleProgressClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!hasAudio) return;
    const track = event.currentTarget;
    const rect = track.getBoundingClientRect();
    const percent = (event.clientX - rect.left) / rect.width;
    seekAudio(Math.max(0, Math.min(duration, percent * duration)));
  };

  const toggleSpeedMenu = (event: React.MouseEvent) => {
    event.stopPropagation();
    setShowSpeedMenu((prev) => !prev);
  };

  const handleSelectPlaybackRate = (rate: number) => {
    setGlobalPlaybackRate(rate);
    setShowSpeedMenu(false);
  };

  return (
    <div className={styles.audioPlayer}>
      {/* 唱片舞台 */}
      <div className={styles.discStage}>
        <div className={styles.discGlow} />
        <div className={`${styles.disc} ${!isPlaying ? styles.paused : ''}`} />
      </div>

      {/* 曲目信息 */}
      <div className={styles.trackInfo}>
        <p className={styles.trackTitle}>{trackTitle}</p>
        <p className={styles.trackSub}>{trackSub}</p>
      </div>

      {/* 进度条 */}
      <div className={styles.progress}>
        <div className={styles.progressTrack} onClick={handleProgressClick}>
          <div className={styles.progressFill} style={{ width: `${progressPercent}%` }} />
        </div>
        <div className={styles.progressTimes}>
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Transport 控制行 */}
      <div className={styles.transport}>
        {/* 倍速选择器 */}
        <div className={styles.speedControl}>
          <button className={styles.speedPill} onClick={toggleSpeedMenu} aria-label="播放速度">
            {playbackRate}x
          </button>
          <CSSTransition
            in={showSpeedMenu}
            timeout={200}
            classNames={{
              enter: styles.speedMenuEnter,
              enterActive: styles.speedMenuEnterActive,
              exit: styles.speedMenuExit,
              exitActive: styles.speedMenuExitActive,
            }}
            unmountOnExit
            nodeRef={speedMenuRef}
          >
            <div ref={speedMenuRef} className={styles.speedMenu}>
              {PLAYBACK_RATES.map((rate) => (
                <button
                  key={rate.value}
                  className={`${styles.speedOption} ${playbackRate === rate.value ? styles.active : ''}`}
                  onClick={() => handleSelectPlaybackRate(rate.value)}
                >
                  {rate.label}
                </button>
              ))}
            </div>
          </CSSTransition>
        </div>

        {/* 主播放按钮 */}
        <button
          className={styles.playBtn}
          onClick={togglePlay}
          disabled={!hasAudio}
          aria-label={isPlaying ? '暂停' : '播放'}
        >
          {isPlaying ? <Pause size={28} /> : <Play size={28} />}
        </button>

        {/* 右侧占位按钮（视觉平衡） */}
        <button className={styles.tbtn} disabled aria-label="下一首">
          <SkipForward size={20} />
        </button>
      </div>
    </div>
  );
};

export default AudioPlayer;
