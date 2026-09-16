import React, { useCallback, useMemo } from 'react';
import { MoonStar } from 'lucide-react';
import GlassSlider from '@/components/ui/GlassSlider';
import GlassSwitch from '@/components/ui/GlassSwitch';
import {
    SLEEP_TIMER_MAX_MINUTES,
    SLEEP_TIMER_MIN_MINUTES,
    SLEEP_TIMER_STEP_MINUTES,
} from '@/lib/playback/sleepTimer';
import styles from '../index.module.scss';

/**
 *  默认睡眠定时配置模块的入参（spec §29/§31 取代旧“播放时长”）。
 */
interface DefaultSleepTimerSectionProps {
    /** 新 Session 是否默认启用睡眠定时（false=默认 off）。 */
    enabled: boolean;
    /** 默认睡眠定时分钟数（10–120）。 */
    minutes: number;
    /** 开关变化回调。 */
    onEnabledChange: (value: boolean) => void;
    /** 分钟数变化回调。 */
    onMinutesChange: (value: number) => void;
}

/**
 * 设置页面的默认睡眠定时模块：开关 + 10–120 分钟（step 10）。
 * 只改 Settings 默认（新 Session 默认 Timer），不触当前 Session Timer（spec §31.1）。
 */
const DefaultSleepTimerSection: React.FC<DefaultSleepTimerSectionProps> = ({
    enabled,
    minutes,
    onEnabledChange,
    onMinutesChange,
}) => {
    const marks = useMemo<Record<number, string>>(
        () => ({
            [SLEEP_TIMER_MIN_MINUTES]: `${SLEEP_TIMER_MIN_MINUTES}分钟`,
            [SLEEP_TIMER_MIN_MINUTES + SLEEP_TIMER_STEP_MINUTES]: `${SLEEP_TIMER_MIN_MINUTES + SLEEP_TIMER_STEP_MINUTES}分钟`,
            [SLEEP_TIMER_MIN_MINUTES + SLEEP_TIMER_STEP_MINUTES * 2]: `${SLEEP_TIMER_MIN_MINUTES + SLEEP_TIMER_STEP_MINUTES * 2}分钟`,
            60: '60分钟',
            90: '90分钟',
            [SLEEP_TIMER_MAX_MINUTES]: `${SLEEP_TIMER_MAX_MINUTES}分钟`,
        }),
        []
    );

    const handleEnabledChange = useCallback(
        (next: boolean) => {
            if (next !== enabled) {
                onEnabledChange(next);
            }
        },
        [enabled, onEnabledChange]
    );

    const handleMinutesChange = useCallback(
        (next: number) => {
            if (next !== minutes) {
                onMinutesChange(next);
            }
        },
        [minutes, onMinutesChange]
    );

    return (
        <div className={styles.configSection}>
            <h3><MoonStar className={styles.rowIcon} strokeWidth={1.8} />默认睡眠定时</h3>
            <div className={styles.configActionRow}>
                <p className={styles.configDescription}>开启后，新播放默认在设定时长后暂停。关闭后，新播放默认不限时（可在播放页单独设置本次定时）。</p>
                <GlassSwitch
                    isSelected={enabled}
                    onChange={handleEnabledChange}
                    label="默认睡眠定时开关"
                />
            </div>
            {enabled ? (
                <div className={styles.configField}>
                    <GlassSlider
                        min={SLEEP_TIMER_MIN_MINUTES}
                        max={SLEEP_TIMER_MAX_MINUTES}
                        step={SLEEP_TIMER_STEP_MINUTES}
                        marks={marks}
                        value={minutes}
                        onChange={handleMinutesChange}
                    />
                </div>
            ) : null}
        </div>
    );
};

export default DefaultSleepTimerSection;
