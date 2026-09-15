'use client';

/**
 * M7-02 PlaybackRateControl（spec §20/§20.1 当前 Session 级倍速）。
 *
 * - 七档冻结（与旧 AudioPlayer 一致，先不改用户行为）：0.8 / 0.9 / 0.95 / 1.0 /
 *   1.05 / 1.1 / 1.5；
 * - 受控组件：currentRate 全部来自 ViewModel.playbackRate（Session.speed），
 *   本组件不建 Expanded-local speed state；
 * - 选择经 onSelect → facade.setPlaybackRate → Session.speed +
 *   Transport.playbackRate + Anchor 持久化；不写回 UserConfig 默认 speed；
 *   不触发新 TTS（只调 <audio>.playbackRate，M8 Canonical TTS speed=1.0）。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

/** 七档冻结（spec §20，先不趁迁移改用户行为）。 */
export const EXPANDED_PLAYBACK_RATES = [
    { value: 0.8, label: '0.8x' },
    { value: 0.9, label: '0.9x' },
    { value: 0.95, label: '0.95x' },
    { value: 1.0, label: '1.0x' },
    { value: 1.05, label: '1.05x' },
    { value: 1.1, label: '1.1x' },
    { value: 1.5, label: '1.5x' },
] as const;

/** 七档值联合类型。 */
export type ExpandedPlaybackRateValue = (typeof EXPANDED_PLAYBACK_RATES)[number]['value'];

/**
 * 纯函数：是否为支持档（UI 侧合法性门，非法值不派发）。
 */
export const isSupportedPlaybackRate = (rate: number): boolean =>
    (EXPANDED_PLAYBACK_RATES as ReadonlyArray<{ value: number }>).some((entry) => entry.value === rate);

/**
 * 纯函数：倍速标签（未命中回退 `${rate}x`，保证总有可读文本）。
 */
export const formatPlaybackRateLabel = (rate: number): string => {
    const matched = (EXPANDED_PLAYBACK_RATES as ReadonlyArray<{ value: number; label: string }>).find(
        (entry) => entry.value === rate
    );
    if (matched) {
        return matched.label;
    }
    return `${rate}x`;
};

/** PlaybackRateControl props（全部受控）。 */
export type PlaybackRateControlProps = {
    /** 当前倍速（ViewModel.playbackRate = Session.speed）。 */
    currentRate: number;
    /** 选择回调（父级经 facade.setPlaybackRate 传入）。 */
    onSelect: (rate: number) => void;
    /** 是否禁用（无 session 时 true）。 */
    disabled?: boolean;
};

export const PlaybackRateControl: React.FC<PlaybackRateControlProps> = ({
    currentRate,
    onSelect,
    disabled = false,
}) => {
    const [showMenu, setShowMenu] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!showMenu) {
            return;
        }
        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as HTMLElement | null;
            if (target && menuRef.current && !menuRef.current.contains(target)) {
                setShowMenu(false);
            }
        };
        document.addEventListener('click', handleClickOutside);
        return () => {
            document.removeEventListener('click', handleClickOutside);
        };
    }, [showMenu]);

    const toggleMenu = useCallback(
        (event: React.MouseEvent) => {
            event.stopPropagation();
            if (disabled) {
                return;
            }
            setShowMenu((prev) => !prev);
        },
        [disabled]
    );

    const handleSelect = useCallback(
        (rate: number) => {
            if (!isSupportedPlaybackRate(rate)) {
                return;
            }
            onSelect(rate);
            setShowMenu(false);
        },
        [onSelect]
    );

    return (
        <div data-testid="expanded-rate-control" ref={menuRef}>
            <button
                type="button"
                data-testid="expanded-rate-pill"
                onClick={toggleMenu}
                disabled={disabled}
                aria-label="播放速度"
                aria-expanded={showMenu}
                aria-haspopup="menu"
            >
                {formatPlaybackRateLabel(currentRate)}
            </button>
            {showMenu ? (
                <div data-testid="expanded-rate-menu" role="menu" aria-label="选择播放速度">
                    {EXPANDED_PLAYBACK_RATES.map((rate) => (
                        <button
                            key={rate.value}
                            type="button"
                            role="menuitemradio"
                            aria-checked={currentRate === rate.value}
                            data-testid={`expanded-rate-option-${rate.value}`}
                            onClick={() => handleSelect(rate.value)}
                        >
                            {rate.label}
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
};

export default PlaybackRateControl;
