'use client';

import React, { useEffect, useRef, useState } from 'react';
import { CSSTransition } from 'react-transition-group';
import { Toast } from 'antd-mobile';
import PlayIcon from '@/public/icons/audioplayer-play.svg';
import PauseIcon from '@/public/icons/audioplayer-pause.svg';
import BackgroundIcon from '@/public/icons/audioplayer-background.svg';
import { usePlaybackStore, useFloatingPlayer } from '@/stores/playbackStore';
import { cx } from '@/utils/cx';

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
 * 播放速度菜单过渡类名配置。
 */
const SPEED_MENU_TRANSITION = {
  enter: 'opacity-0 translate-y-[10px] scale-[0.95]',
  enterActive: 'opacity-100 translate-y-0 scale-100 transition-all duration-200 ease-out',
  exit: 'opacity-100 translate-y-0 scale-100',
  exitActive: 'opacity-0 translate-y-[10px] scale-[0.95] transition-all duration-150 ease-in',
} as const;

/**
 * 用于定位速度菜单的容器类名。
 */
const SPEED_CONTROL_CLASS = 'audio-speed-control';

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
        if (!target.closest(`.${SPEED_CONTROL_CLASS}`)) {
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
        Toast.show({ icon: 'fail', content: message, duration: 3000 });
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
    <div className="mx-auto mb-[10px] w-full rounded-2xl border border-[var(--card-border)] bg-[var(--card-background)] p-5 shadow-[0_8px_16px_var(--shadow-color)] transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)] backdrop-blur-[var(--blur-radius)]">
      <div
        className={cx(
          'relative mx-auto mb-5 flex h-[200px] w-[200px] items-center justify-center overflow-hidden rounded-full border-[4px] border-[color:color-mix(in_srgb,var(--card-background)_80%,var(--primary))] shadow-[0_10px_20px_var(--shadow-color)] transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)]',
          isPlaying && 'animate-[spin_20s_linear_infinite]'
        )}
      >
        <div
          className="absolute left-1/2 top-1/2 h-[30%] w-[30%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color-mix(in_srgb,var(--card-background)_70%,var(--primary))] shadow-[0_0_20px_var(--shadow-color)]"
        />
        <div
          className="absolute z-30 flex h-[50px] w-[50px] items-center justify-center rounded-full bg-[var(--primary)] text-white shadow-[0_4px_12px_color-mix(in_srgb,var(--primary)_50%,transparent)] transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)] backdrop-blur-[5px] hover:scale-110 active:scale-95"
          onClick={togglePlay}
        >
          {isPlaying ? <PauseIcon className="h-7 w-7" /> : <PlayIcon className="h-7 w-7" />}
        </div>
        <div className="absolute inset-0">
          <BackgroundIcon className="h-[196px] w-[196px]" />
        </div>
      </div>
      <div className="mx-auto mt-5 flex w-full max-w-[400px] items-center gap-[5px]">
        <span className="min-w-[45px] text-center text-sm font-medium text-[var(--secondary)] [font-variant-numeric:tabular-nums]">
          {formatTime(currentTime)}
        </span>
        <input
          ref={progressBarRef}
          type="range"
          className="audio-player-progress h-[6px] flex-1 cursor-pointer appearance-none rounded-[3px] bg-[color-mix(in_srgb,var(--border)_50%,transparent)] transition-[height] duration-[var(--transition-speed)] ease-[var(--transition-timing)] hover:h-2"
          value={currentTime}
          min={0}
          max={duration || 0}
          step={0.1}
          onChange={handleSeekChange}
        />
        <span className="min-w-[45px] text-center text-sm font-medium text-[var(--secondary)] [font-variant-numeric:tabular-nums]">
          {formatTime(duration)}
        </span>
        <div className={cx('relative', SPEED_CONTROL_CLASS)}>
          <button
            className="w-[50px] rounded-[12px] border border-[color-mix(in_srgb,var(--primary)_30%,transparent)] bg-[color-mix(in_srgb,var(--card-background)_80%,var(--primary))] px-[5px] py-1 text-sm font-medium text-[var(--foreground)] shadow-[0_2px_8px_color-mix(in_srgb,var(--primary)_30%,transparent)] transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)] backdrop-blur-[5px] hover:scale-105 hover:shadow-[0_4px_12px_color-mix(in_srgb,var(--primary)_40%,transparent)] active:scale-95 active:shadow-[0_1px_4px_color-mix(in_srgb,var(--primary)_20%,transparent)]"
            onClick={toggleSpeedMenu}
            aria-label="播放速度"
          >
            {playbackRate}x
          </button>
          <CSSTransition
            in={showSpeedMenu}
            timeout={200}
            classNames={SPEED_MENU_TRANSITION}
            unmountOnExit
            nodeRef={speedMenuRef}
          >
            <div
              ref={speedMenuRef}
              className="audio-player-speed-menu absolute bottom-[calc(100%+8px)] right-0 z-10 flex w-[100px] flex-col gap-1 rounded-[12px] border border-[var(--card-border)] bg-[var(--card-background)] p-2 shadow-[0_8px_24px_var(--shadow-color)] backdrop-blur-[15px]"
            >
              {PLAYBACK_RATES.map((rate) => (
                <button
                  key={rate.value}
                  className={cx(
                    'rounded-[8px] border-0 bg-transparent px-[10px] py-[6px] text-center text-sm text-[var(--foreground)] transition-colors duration-[var(--transition-speed)] ease-[var(--transition-timing)] hover:bg-[color-mix(in_srgb,var(--primary)_10%,transparent)]',
                    playbackRate === rate.value && 'bg-[color-mix(in_srgb,var(--primary)_20%,transparent)] font-medium text-[var(--primary)]'
                  )}
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
