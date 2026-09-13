'use client';

/**
 * M7-02 useExpandedPlaybackControls（spec §16 Playback Controls Facade）。
 *
 * Expanded 唯一播放操作入口：
 * ```ts
 * {
 *   play()
 *   pause()
 *   restart()
 *   seekCurrentSegment(seconds)
 *   seekRelative(seconds)
 *   setPlaybackRate(rate)
 * }
 * ```
 * - 全部走 M5 ownership（flow/Transport command → Session + AudioControllerHost）；
 * - UI 不得直接 set Session 字段或操作 <audio>（本 hook 不 import 任何 store 写面 /
 *   audioController / M8.ensureSegment；只委托 playbackSessionFlow）；
 * - P3B 再增加 seekStoryPosition(ms)（本轮不提供，避免 UI 层散落跨域操作）。
 *
 * 错误面：play/restart 失败经 GlassToast 提示（与 Mini 同口径），seek/pause
 * 同步失败静默（transport 无控制器时 flow 侧 no-op）。
 */

import { useCallback } from 'react';
import GlassToast from '@/components/ui/GlassToast';
import {
    pausePlayback,
    resumePlayback,
    restartPlayback,
    seekCurrentSegment as flowSeekCurrentSegment,
    seekRelative as flowSeekRelative,
    setPlaybackRate as flowSetPlaybackRate,
} from '@/app/services/playbackSessionFlow';

/** Expanded 播放控制门面（组件唯一依赖的播放写面）。 */
export type ExpandedPlaybackControls = {
    /** 播放（resume 已水合断点；error 重试同一路径）。 */
    play: () => void;
    /** 暂停（transport + checkpoint debounce）。 */
    pause: () => void;
    /** 从头播放（Work 新 UUID / Draft 本地 finite）。 */
    restart: () => void;
    /** 当前 Segment seek（秒，全 clamp + fail-safe）。 */
    seekCurrentSegment: (targetSeconds: number) => void;
    /** 相对 seek（秒，keyboard ±5s 经此入口）。 */
    seekRelative: (deltaSeconds: number) => void;
    /** 当前 Session 倍速（七档；不写回 UserConfig，不触发新 TTS）。 */
    setPlaybackRate: (rate: number) => void;
};

export const useExpandedPlaybackControls = (): ExpandedPlaybackControls => {
    const play = useCallback(() => {
        resumePlayback().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : '语音生成稍有延迟，请重试';
            GlassToast.show({ icon: 'fail', content: message, duration: 3000 });
        });
    }, []);

    const pause = useCallback(() => {
        try {
            pausePlayback();
        } catch (error) {
            const message = error instanceof Error ? error.message : '暂停失败，请重试';
            GlassToast.show({ icon: 'fail', content: message, duration: 3000 });
        }
    }, []);

    const restart = useCallback(() => {
        restartPlayback().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : '重播失败，请重试';
            GlassToast.show({ icon: 'fail', content: message, duration: 3000 });
        });
    }, []);

    const seekCurrentSegment = useCallback((targetSeconds: number) => {
        try {
            flowSeekCurrentSegment(targetSeconds);
        } catch {
            // seek 同步失败静默（fail-safe no-op，不打断播放）。
        }
    }, []);

    const seekRelative = useCallback((deltaSeconds: number) => {
        try {
            flowSeekRelative(deltaSeconds);
        } catch {
            // ignore
        }
    }, []);

    const setPlaybackRate = useCallback((rate: number) => {
        flowSetPlaybackRate(rate).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : '切换倍速失败，请重试';
            GlassToast.show({ icon: 'fail', content: message, duration: 3000 });
        });
    }, []);

    return { play, pause, restart, seekCurrentSegment, seekRelative, setPlaybackRate };
};

export default useExpandedPlaybackControls;
