"use client";

import React, { useEffect, useRef, useState } from "react";
import { CSSTransition } from "react-transition-group";
import { Toast } from "antd-mobile";
import PlayIcon from "@/public/icons/audioplayer-play.svg";
import PauseIcon from "@/public/icons/audioplayer-pause.svg";
import BackgroundIcon from "@/public/icons/audioplayer-background.svg";
import { usePlaybackStore, useFloatingPlayer } from "@/stores/playbackStore";
import { cx } from "@/utils/cx";
import styles from "./AudioPlayer.module.css";

/**
 * 同步滑块进度样式，确保轨道渲染与当前进度一致。
 * @param slider DOM 节点引用
 * @param percent 进度百分比
 */
const syncSliderProgress = (
  slider: HTMLInputElement | null,
  percent: number,
): void => {
  if (!slider) {
    return;
  }
  const boundedPercent = Number.isFinite(percent)
    ? Math.min(Math.max(percent, 0), 100)
    : 0;
  slider.style.setProperty("--progress-percent", `${boundedPercent}%`);
};

/**
 * 可选的播放速度列表，按按钮顺序显示。
 */
const PLAYBACK_RATES = [
  { value: 0.8, label: "0.8x" },
  { value: 0.9, label: "0.9x" },
  { value: 0.95, label: "0.95x" },
  { value: 1, label: "1x" },
  { value: 1.05, label: "1.05x" },
  { value: 1.1, label: "1.1x" },
  { value: 1.5, label: "1.5x" },
] as const;

/**
 * 播放速度菜单过渡类名配置。
 */
const SPEED_MENU_TRANSITION = {
  enter: "opacity-0 translate-y-2.5 scale-95",
  enterActive:
    "opacity-100 translate-y-0 scale-100 transition-all duration-200 ease-out",
  exit: "opacity-100 translate-y-0 scale-100",
  exitActive:
    "opacity-0 translate-y-2.5 scale-95 transition-all duration-150 ease-in",
} as const;

/**
 * 用于定位速度菜单的容器类名。
 */
const SPEED_CONTROL_CLASS = "audio-speed-control";

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
  const setGlobalPlaybackRate = usePlaybackStore(
    (state) => state.setPlaybackRate,
  );
  const { resume, pause } = useFloatingPlayer();

  const hasAudio = duration > 0;

  useEffect(() => {
    const progressBar = progressBarRef.current;
    if (!progressBar) {
      return;
    }
    const percent = duration > 0 ? (currentTime / duration) * 100 : 0;
    syncSliderProgress(progressBar, percent);
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

    document.addEventListener("click", handleClickOutside);
    return () => {
      document.removeEventListener("click", handleClickOutside);
    };
  }, [showSpeedMenu]);

  const formatTime = (time: number): string => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const togglePlay = () => {
    if (!hasAudio) {
      return;
    }
    if (isPlaying) {
      pause();
    } else {
      resume().catch((error) => {
        const message = error instanceof Error ? error.message : "无法恢复播放";
        Toast.show({ icon: "fail", content: message, duration: 3000 });
      });
    }
  };

  const handleSeekChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const slider = event.currentTarget;
    const time = parseFloat(slider.value);
    seekAudio(time);
    if (duration > 0) {
      const percent = (time / duration) * 100;
      syncSliderProgress(slider, percent);
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
    <div className="surface-card mx-auto mb-sm w-full p-5">
      <div
        className={cx(
          "relative mx-auto mb-5 flex items-center justify-center overflow-hidden rounded-full border-4 border-surface-accent shadow-panel transition-transform duration-theme ease-theme",
          styles.disc,
          isPlaying && "animate-[spin_20s_linear_infinite]",
        )}
      >
        <div className="absolute left-1/2 top-1/2 h-[30%] w-[30%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-surface-accent shadow-surface-ambient" />
        <div
          className={cx(
            "absolute z-30 flex items-center justify-center rounded-full bg-primary text-white shadow-primary-glow backdrop-blur-soft transition-transform duration-theme ease-theme hover:scale-110 hover:shadow-primary-glow-strong active:scale-95 active:shadow-primary-glow-muted",
            styles.centerButton,
          )}
          onClick={togglePlay}
        >
          {isPlaying ? (
            <PauseIcon className="h-7 w-7" />
          ) : (
            <PlayIcon className="h-7 w-7" />
          )}
        </div>
        <div className="absolute inset-0">
          <BackgroundIcon className={styles.disc} />
        </div>
      </div>
      <div className="mx-auto mt-5 flex w-full max-w-[var(--size-max-width-player)] items-center gap-xs">
        <span
          className={cx(
            styles.timeLabel,
            "text-center text-sm font-medium text-foreground-secondary [font-variant-numeric:tabular-nums]",
          )}
        >
          {formatTime(currentTime)}
        </span>
        <input
          ref={progressBarRef}
          type="range"
          className={cx(
            styles.progress,
            "flex-1 cursor-pointer appearance-none rounded-sm transition-[height] duration-theme ease-theme hover:h-2",
          )}
          value={currentTime}
          min={0}
          max={duration || 0}
          step={0.1}
          onChange={handleSeekChange}
        />
        <span
          className={cx(
            styles.timeLabel,
            "text-center text-sm font-medium text-foreground-secondary [font-variant-numeric:tabular-nums]",
          )}
        >
          {formatTime(duration)}
        </span>
        <div className={cx("relative", SPEED_CONTROL_CLASS)}>
          <button
            className="btn-speed-control"
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
              className={cx(
                styles.speedMenu,
                styles.speedMenuContainer,
                "absolute bottom-[calc(100%+8px)] right-0 z-10 flex flex-col gap-1 rounded-xl border border-border-card bg-surface p-2 shadow-surface-lg backdrop-blur-panel",
              )}
            >
              {PLAYBACK_RATES.map((rate) => (
                <button
                  key={rate.value}
                  className={cx(
                    "rounded-lg border-0 bg-transparent px-sm py-1.5 text-center text-sm text-foreground transition-colors duration-theme ease-theme hover:bg-surface-interactive",
                    playbackRate === rate.value &&
                      "bg-surface-primary-strong font-medium text-primary",
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
