import React, {
  useRef,
  useState,
  useEffect,
  forwardRef,
  ForwardedRef,
  useImperativeHandle,
  useCallback,
} from 'react';
import { CSSTransition } from 'react-transition-group';
import { Toast } from '../Toast';
import PlayIcon from '@/public/icons/audioplayer-play.svg';
import PauseIcon from '@/public/icons/audioplayer-pause.svg';
import BackgroundIcon from '@/public/icons/audioplayer-background.svg';
import styles from './index.module.scss';

interface AudioPlayerProps {
  onPlay?: () => void;
  onPause?: () => void;
  onEnded?: () => void;
  onNearEnd?: () => void;
  onProgress?: (payload: { currentTime: number; duration: number }) => void;
}

export interface AudioPlayerHandle {
  play: (audioUrl: string) => Promise<void>;
  pause: () => void;
  seek: (time: number) => void;
  setPlaybackRate: (rate: number) => void;
}

const PLAYBACK_RATES = [
  { value: 0.8, label: '0.8x' },
  { value: 0.9, label: '0.9x' },
  { value: 0.95, label: '0.95x' },
  { value: 1, label: '1x' },
  { value: 1.05, label: '1.05x' },
  { value: 1.1, label: '1.1x' },
  { value: 1.5, label: '1.5x' },
];

export const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(
  ({ onPlay, onPause, onEnded, onNearEnd, onProgress }, ref: ForwardedRef<AudioPlayerHandle>) => {
    const audioRef = useRef<HTMLAudioElement>(null);
    const progressBarRef = useRef<HTMLInputElement>(null);
    const speedMenuRef = useRef<HTMLDivElement>(null);
    const hasTriggeredPreload = useRef(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [progressPercent, setProgressPercent] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [playbackRate, setPlaybackRate] = useState(1);
    const [showSpeedMenu, setShowSpeedMenu] = useState(false);

    const handlePlay = useCallback(
      async (audioUrl: string) => {
        if (!audioRef.current) {
          throw new Error('音频播放器尚未就绪');
        }

        // 重置内部播放状态
        audioRef.current.src = audioUrl;
        hasTriggeredPreload.current = false;
        setCurrentTime(0);
        setDuration(0);
        setProgressPercent(0);
        if (progressBarRef.current) {
          progressBarRef.current.style.setProperty('--progress-percent', '0%');
        }
        // 设置播放速度
        audioRef.current.playbackRate = playbackRate;
        // 启动播放
        try {
          await audioRef.current.play();
          setIsPlaying(true);
          onPlay?.();
        } catch (error) {
          console.error('播放失败:', error);
          setIsPlaying(false);
          onPause?.();
          throw error instanceof Error ? error : new Error('无法播放音频');
        }
      },
      [onPlay, onPause, playbackRate]
    );

    const handlePause = useCallback(() => {
      if (audioRef.current) {
        audioRef.current.pause();
        setIsPlaying(false);
        onPause && onPause();
      }
    }, [onPause]);

    const handleSeek = useCallback(
      (time: number) => {
        if (audioRef.current) {
          audioRef.current.currentTime = time;
          setCurrentTime(time);
          if (duration > 0) {
            const percent = (time / duration) * 100;
            setProgressPercent(percent);
            if (progressBarRef.current) {
              progressBarRef.current.style.setProperty('--progress-percent', `${percent}%`);
            }
          }
        }
      },
      [duration]
    );

    const handleSetPlaybackRate = useCallback((rate: number) => {
      if (audioRef.current) {
        audioRef.current.playbackRate = rate;
        setPlaybackRate(rate);
        setShowSpeedMenu(false);
      }
    }, []);

    useImperativeHandle(ref, () => ({
      play: handlePlay,
      pause: handlePause,
      seek: handleSeek,
      setPlaybackRate: handleSetPlaybackRate,
    }));

    // 监听时间更新和元数据加载
    useEffect(() => {
      const audioEl = audioRef.current;
      if (!audioEl) return;
      const handleTimeUpdate = () => {
        const ct = audioEl.currentTime;
        setCurrentTime(ct);
        if (audioEl.duration > 0) {
          const percent = (ct / audioEl.duration) * 100;
          setProgressPercent(percent);
          if (progressBarRef.current) {
            progressBarRef.current.style.setProperty('--progress-percent', `${percent}%`);
          }
        }
        if (onProgress) {
          onProgress({
            currentTime: ct,
            duration: audioEl.duration,
          });
        }
        if (onNearEnd && !hasTriggeredPreload.current) {
          const timeRemaining = audioEl.duration - ct;
          if (timeRemaining <= 120) {
            hasTriggeredPreload.current = true;
            onNearEnd();
          }
        }
      };
      const handleLoadedMetadata = () => {
        setDuration(audioEl.duration);
        setCurrentTime(0);
        setProgressPercent(0);
        if (progressBarRef.current) {
          progressBarRef.current.style.setProperty('--progress-percent', '0%');
        }
        hasTriggeredPreload.current = false;
      };
      audioEl.addEventListener('timeupdate', handleTimeUpdate);
      audioEl.addEventListener('loadedmetadata', handleLoadedMetadata);
      return () => {
        audioEl.removeEventListener('timeupdate', handleTimeUpdate);
        audioEl.removeEventListener('loadedmetadata', handleLoadedMetadata);
      };
    }, [onNearEnd, onProgress]);

    // 点击外部关闭速度选择菜单
    useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
        const target = event.target as HTMLElement;
        if (showSpeedMenu && !target.closest(`.${styles.speedControl}`)) {
          setShowSpeedMenu(false);
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

    // 点击播放/暂停按钮时切换状态
    const togglePlay = () => {
      if (!audioRef.current?.src) {
        Toast({ type: 'error', message: '生成故事，再启动播放哦~' });
        return;
      }
      if (isPlaying) {
        audioRef.current.pause();
        setIsPlaying(false);
        onPause && onPause();
      } else {
        audioRef.current
          .play()
          .then(() => {
            setIsPlaying(true);
            onPlay && onPlay();
          })
          .catch((error) => {
            console.error('播放失败:', error);
            onPause && onPause();
          });
      }
    };

    const handleSeekCallback = (event: React.ChangeEvent<HTMLInputElement>) => {
      const time = parseFloat(event.target.value);
      if (audioRef.current) {
        audioRef.current.currentTime = time;
        setCurrentTime(time);
        if (duration > 0) {
          const percent = (time / duration) * 100;
          setProgressPercent(percent);
          event.target.style.setProperty('--progress-percent', `${percent}%`);
        }
      }
    };

    const toggleSpeedMenu = (e: React.MouseEvent) => {
      e.stopPropagation();
      setShowSpeedMenu(!showSpeedMenu);
    };

    return (
      <div className={styles.audioPlayer}>
        <div className={`${styles.recordDisc} ${isPlaying ? styles.recordDiscPlaying : ''}`}>
          <div className={styles.playButton} onClick={togglePlay}>
          {isPlaying ? (
              <PauseIcon className={styles.icon} />
            ) : (
              <PlayIcon className={styles.icon} />
            )}
          </div>
          <div className={styles.backgroundIcon}>
            <BackgroundIcon />
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
            max={duration}
            step={0.1}
            onChange={handleSeekCallback}
          />
          <span className={styles.timeDisplay}>{formatTime(duration)}</span>
          <div className={styles.speedControl}>
            <button 
              className={styles.speedButton} 
              onClick={toggleSpeedMenu}
              aria-label="播放速度"
            >
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
                    onClick={() => handleSetPlaybackRate(rate.value)}
                  >
                    {rate.label}
                  </button>
                ))}
              </div>
            </CSSTransition>
          </div>
        </div>
        <audio ref={audioRef} onEnded={onEnded} />
      </div>
    );
  }
);

AudioPlayer.displayName = 'AudioPlayer';
