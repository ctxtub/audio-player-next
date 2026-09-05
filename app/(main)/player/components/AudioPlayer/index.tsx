'use client';

import React, { useEffect, useRef, useState } from 'react';
import { CSSTransition } from 'react-transition-group';
import { Play, Pause, RotateCcw } from 'lucide-react';
import GlassToast from '@/components/ui/GlassToast';
import { usePlaybackStore, useFloatingPlayer } from '@/stores/playbackStore';
import { usePlaybackProgressStore } from '@/stores/playbackProgressStore';
import { useChatStore } from '@/stores/chatStore';
import { useConfigStore } from '@/stores/configStore';
import { AUTO_CONTINUE_PROMPT } from '@/app/services/chatFlow';
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
  const isRehydratedReady = usePlaybackStore((state) => state.isRehydratedReady);
  const storeTitle = usePlaybackStore((state) => state.title);
  const currentParagraphIndex = usePlaybackStore((state) => state.currentParagraphIndex);
  const totalParagraphs = usePlaybackStore((state) => state.totalParagraphs);
  const { resume, pause } = useFloatingPlayer();

  /* 曲目信息：取故事会话「首条非续写指令」的用户消息作为标题，并叠加当前语音选项。
     取首条而非末条，是为了让标题稳定呈现故事主题；排除自动续写指令「请继续故事」，
     避免标题被预加载发起的续写消息覆盖（见 chatFlow.AUTO_CONTINUE_PROMPT）。 */
  const messages = useChatStore((state) => state.messages);
  const voiceOptions = useConfigStore((state) => state.voiceOptions);
  const voiceId = useConfigStore((state) => state.apiConfig.voiceId);
  const storyPromptMsg = messages.find(
    (m) => m.role === 'user' && m.content.trim() !== AUTO_CONTINUE_PROMPT,
  );
  const trackTitle = storeTitle || (storyPromptMsg ? storyPromptMsg.content.slice(0, 20) : '音频故事');
  const selectedVoice = voiceOptions.find((v) => v.value === voiceId);
  const voiceLabel = selectedVoice ? selectedVoice.label : 'AI 语音';
  const paragraphBadge = totalParagraphs > 1
    ? `第 ${currentParagraphIndex + 1} / ${totalParagraphs} 段${isRehydratedReady ? ' 就绪' : ''}`
    : (isRehydratedReady ? '断点就绪' : '');
  const trackSub = paragraphBadge ? `${paragraphBadge} · ${voiceLabel}` : voiceLabel;

  const hasAudio = duration > 0;
  const isReadyToPlay = duration > 0 || isRehydratedReady;
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
    if (!isReadyToPlay) {
      return;
    }
    if (isPlaying) {
      pause();
    } else if (isRehydratedReady) {
      usePlaybackProgressStore.getState().resumeRehydratedPlayback().catch((error) => {
        const message = error instanceof Error ? error.message : '语音生成稍有延迟，请重试';
        GlassToast.show({ icon: 'fail', content: message, duration: 3000 });
      });
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

  /** 进度条键盘可达：方向键 ±5 秒、Home/End 跳到首尾。 */
  const handleProgressKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!hasAudio) return;
    const STEP = 5;
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        next = currentTime - STEP;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        next = currentTime + STEP;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = duration;
        break;
      default:
        return;
    }
    event.preventDefault();
    seekAudio(Math.max(0, Math.min(duration, next)));
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
        <div
          className={styles.progressTrack}
          onClick={handleProgressClick}
          onKeyDown={handleProgressKeyDown}
          role="slider"
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={Math.floor(duration)}
          aria-valuenow={Math.floor(currentTime)}
          aria-valuetext={`${formatTime(currentTime)} / ${formatTime(duration)}`}
          aria-disabled={!hasAudio}
          tabIndex={hasAudio ? 0 : -1}
        >
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
          <button type="button" className={styles.speedPill} onClick={toggleSpeedMenu} aria-label="播放速度">
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
                  type="button"
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
          type="button"
          className={styles.playBtn}
          onClick={togglePlay}
          disabled={!isReadyToPlay}
          aria-label={isPlaying ? '暂停' : '播放'}
        >
          {isPlaying ? <Pause size={28} /> : <Play size={28} />}
        </button>

        {/* 右侧重播按钮（支持从头重播） */}
        <button
          type="button"
          className={styles.tbtn}
          onClick={() => {
            usePlaybackProgressStore.getState().replayFromStart().catch((error) => {
              const message = error instanceof Error ? error.message : '重播失败';
              GlassToast.show({ icon: 'fail', content: message, duration: 3000 });
            });
          }}
          disabled={!isReadyToPlay && totalParagraphs <= 1}
          aria-label="从头重播"
          title="从头重播"
        >
          <RotateCcw size={20} />
        </button>
      </div>
    </div>
  );
};

export default AudioPlayer;
