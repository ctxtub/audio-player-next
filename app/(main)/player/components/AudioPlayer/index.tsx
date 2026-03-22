'use client';

import React, { useEffect, useRef, useState } from 'react';
import { CSSTransition } from 'react-transition-group';
import { Play, Pause, Disc3 } from 'lucide-react';
import GlassToast from '@/components/ui/GlassToast';
import { usePlaybackStore, useFloatingPlayer } from '@/stores/playbackStore';
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
 * 播放器页面的音频控制组件，展示进度、倍速与播放按钮。
 * @returns JSX.Element 播放器 UI
 */
const AudioPlayer: React.FC = () => {
  const progressBarRef = useRef<HTMLInputElement>(null);
  const speedMenuRef = useRef<HTMLDivElement>(null);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const playbackRate = usePlaybackStore((state) => state.playbackRate);
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const duration = usePlaybackStore((state) => state.duration);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const seekAudio = usePlaybackStore((state) => state.seekAudio);
  const setGlobalPlaybackRate = usePlaybackStore((state) => state.setPlaybackRate);
  const { resume, pause } = useFloatingPlayer();

  const hasAudio = duration > 0;

  useEffect(() => {
    const progressBar = progressBarRef.current;
    if (!progressBar) {
      return;
    }
    const percent = duration > 0 ? (currentTime / duration) * 100 : 0;
    progressBar.style.setProperty('--progress-percent', `${percent}%`);
  }, [currentTime, duration]);

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

  const handleSeekChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(event.target.value);
    seekAudio(time);
    if (duration > 0) {
      const percent = (time / duration) * 100;
      event.target.style.setProperty('--progress-percent', `${percent}%`);
    }
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
      <div className={`${styles.recordDisc} ${isPlaying ? styles.recordDiscPlaying : ''}`}>
        <div className={styles.playButton} onClick={togglePlay}>
          {isPlaying ? <Pause size={32} strokeWidth={2} className={styles.icon} /> : <Play size={32} strokeWidth={2} className={styles.icon} />}
        </div>
        <div className={styles.backgroundIcon}>
          <Disc3 size={120} strokeWidth={0.5} />
        </div>
      </div>
      <div className={styles.audioControls}>
        <span className={styles.timeDisplay}>{formatTime(currentTime)}</span>
        <input
          ref={progressBarRef}
          type="range"
          className={styles.progressBar}
          value={currentTime}
          min={0}
          max={duration || 0}
          step={0.1}
          onChange={handleSeekChange}
        />
        <span className={styles.timeDisplay}>{formatTime(duration)}</span>
        <div className={styles.speedControl}>
          <button className={styles.speedButton} onClick={toggleSpeedMenu} aria-label="播放速度">
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
      </div>
    </div>
  );
};

export default AudioPlayer;
