'use client';

/**
 * M7-03 SleepTimerControl（spec §31.1/§32 Expanded 快捷 Timer）。
 *
 * - 快捷选项：关闭 / 10 / 20 / 30 / 60 / 自定义（10–120，step 10）/
 *   本故事结束后（仅 Work；Draft 不显示该选项，§22.1）；
 * - 受控组件：mode/remainingMs 全部来自 ViewModel（Session.sleepTimerMode +
 *   Transport.remainingMs），本组件不建本地 timer state；
 * - 选择经 onSelect → facade.setSleepTimer → flow → playback.setSleepTimer；
 *   只改当前 Session Timer，不自动改 Settings 默认（§31.1）；
 * - 展示（§32）：off → “睡眠定时 · 关闭”；minutes → “MM:SS 后暂停”；
 *   story_end → “本故事结束后”；
 * - 弹层为 Dialog 内联展开（不 portal 到 overlay DOM 外），Escape 关闭菜单时
 *   stopPropagation（焦点在菜单内，RAC Dialog 不应同时关闭；M7-02 复审约束 9
 *   的内联形态——无外部 portal 即无 Escape ownership 争议）。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    SLEEP_TIMER_MAX_MINUTES,
    SLEEP_TIMER_MIN_MINUTES,
    SLEEP_TIMER_PRESET_MINUTES,
    SLEEP_TIMER_STEP_MINUTES,
    formatSleepTimerRemaining,
    type SleepTimerMode,
} from '@/lib/playback/sleepTimer';

/** SleepTimer 选择结果（facade 入参形态）。 */
export type SleepTimerSelection =
    | { mode: 'off' }
    | { mode: 'minutes'; minutes: number }
    | { mode: 'story_end' };

/** SleepTimerControl props（全部受控）。 */
export type SleepTimerControlProps = {
    /** 当前三态（ViewModel.sleepTimer.mode = Session.sleepTimerMode）。 */
    mode: SleepTimerMode;
    /** minutes 剩余毫秒（ViewModel.sleepTimer.remainingMs）。 */
    remainingMs: number | null;
    /** 是否为 Work source（story_end 选项门，§22.1）。 */
    isWork: boolean;
    /** 是否禁用（无 session 时 true）。 */
    disabled?: boolean;
    /** 选择回调（父级经 facade.setSleepTimer 传入）。 */
    onSelect: (selection: SleepTimerSelection) => void;
};

/** 展示模型（纯函数，可独立测试）。 */
export type SleepTimerControlModel = {
    /** pill 主文案（§32）。 */
    displayLabel: string;
    /** pill 无障碍标签。 */
    ariaLabel: string;
    /** 是否展示 story_end 选项。 */
    showStoryEnd: boolean;
};

/**
 * 纯函数：由 mode/remaining 推导展示（§32）。
 * - off → 关闭；minutes → “MM:SS 后暂停”（remaining 非法回退“定时播放中”）；
 * - story_end → 本故事结束后。
 */
export const deriveSleepTimerControlModel = (
    mode: SleepTimerMode,
    remainingMs: number | null,
    isWork: boolean,
): SleepTimerControlModel => {
    if (mode === 'story_end') {
        return { displayLabel: '本故事结束后', ariaLabel: '睡眠定时：本故事结束后停止', showStoryEnd: isWork };
    }
    if (mode === 'minutes') {
        const remaining = formatSleepTimerRemaining(remainingMs);
        return {
            displayLabel: remaining ? `${remaining} 后暂停` : '定时播放中',
            ariaLabel: remaining ? `睡眠定时：${remaining}后暂停` : '睡眠定时：定时播放中',
            showStoryEnd: isWork,
        };
    }
    return { displayLabel: '睡眠定时 · 关闭', ariaLabel: '睡眠定时：已关闭', showStoryEnd: isWork };
};

/**
 * 纯函数：自定义分钟数合法性（10–120 整数；step 10 由 input step 约束，server 接受区间内任意整数）。
 */
export const isValidCustomSleepTimerMinutes = (value: number): boolean =>
    Number.isInteger(value) && value >= SLEEP_TIMER_MIN_MINUTES && value <= SLEEP_TIMER_MAX_MINUTES;

export const SleepTimerControl: React.FC<SleepTimerControlProps> = ({
    mode,
    remainingMs,
    isWork,
    disabled = false,
    onSelect,
}) => {
    const [showMenu, setShowMenu] = useState(false);
    const [customMinutes, setCustomMinutes] = useState<string>('');
    const menuRef = useRef<HTMLDivElement>(null);
    const model = deriveSleepTimerControlModel(mode, remainingMs, isWork);

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
        (selection: SleepTimerSelection) => {
            onSelect(selection);
            setShowMenu(false);
        },
        [onSelect]
    );

    // Escape 所有权（M7-02 复审约束 9 的内联形态实现）：
    // RAC overlay 把 Escape 挂在祖先 overlay 元素的冒泡监听上；菜单打开时本组件
    // 在 document 捕获阶段先消费 Escape（preventDefault + stopPropagation），事件
    // 不再下行至目标与任何冒泡监听（RAC overlay 亦收不到），只关菜单不关 Expanded。
    // 捕获阶段与引擎/焦点位置无关，Chromium/WebKit 双确定性；菜单关闭时不监听，
    // Escape 照常关闭 Expanded 本体。
    useEffect(() => {
        if (!showMenu) {
            return;
        }
        const handleKeyDownCapture = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setShowMenu(false);
            }
        };
        document.addEventListener('keydown', handleKeyDownCapture, true);
        return () => {
            document.removeEventListener('keydown', handleKeyDownCapture, true);
        };
    }, [showMenu]);

    const handleCustomApply = useCallback(() => {
        const parsed = Number(customMinutes);
        if (!isValidCustomSleepTimerMinutes(parsed)) {
            return;
        }
        handleSelect({ mode: 'minutes', minutes: parsed });
    }, [customMinutes, handleSelect]);

    return (
        <div data-testid="expanded-sleep-timer-control" ref={menuRef}>
            <button
                type="button"
                data-testid="expanded-sleep-timer-pill"
                onClick={toggleMenu}
                disabled={disabled}
                aria-label={model.ariaLabel}
                aria-expanded={showMenu}
                aria-haspopup="menu"
            >
                {model.displayLabel}
            </button>
            {showMenu ? (
                <div
                    data-testid="expanded-sleep-timer-menu"
                    role="menu"
                    aria-label="选择睡眠定时"
                >
                    <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={mode === 'off'}
                        data-testid="expanded-sleep-timer-option-off"
                        onClick={() => handleSelect({ mode: 'off' })}
                    >
                        关闭
                    </button>
                    {SLEEP_TIMER_PRESET_MINUTES.map((preset) => (
                        <button
                            key={preset}
                            type="button"
                            role="menuitemradio"
                            aria-checked={mode === 'minutes'}
                            data-testid={`expanded-sleep-timer-option-${preset}`}
                            onClick={() => handleSelect({ mode: 'minutes', minutes: preset })}
                        >
                            {`${preset} 分钟`}
                        </button>
                    ))}
                    <div data-testid="expanded-sleep-timer-custom">
                        <input
                            type="number"
                            data-testid="expanded-sleep-timer-custom-input"
                            aria-label="自定义分钟数（10到120）"
                            min={SLEEP_TIMER_MIN_MINUTES}
                            max={SLEEP_TIMER_MAX_MINUTES}
                            step={SLEEP_TIMER_STEP_MINUTES}
                            value={customMinutes}
                            onChange={(event) => setCustomMinutes(event.target.value)}
                        />
                        <button
                            type="button"
                            data-testid="expanded-sleep-timer-custom-apply"
                            onClick={handleCustomApply}
                            disabled={!isValidCustomSleepTimerMinutes(Number(customMinutes))}
                        >
                            确定
                        </button>
                    </div>
                    {model.showStoryEnd ? (
                        <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={mode === 'story_end'}
                            data-testid="expanded-sleep-timer-option-story_end"
                            onClick={() => handleSelect({ mode: 'story_end' })}
                        >
                            本故事结束后
                        </button>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};

export default SleepTimerControl;
