/**
 * 音频 `ended` 守卫：隔离解锁静音片段的 `ended` 事件，保护首个真实 `ended`。
 *
 * 背景（R15）：解锁流程为静音片段置位“忽略下一次 ended”标记，但解锁内
 * `play()` 后紧跟 `pause()`，静音片段永不触发 `ended`，标记残留并吞掉首个
 * 真实内容的 `ended`（段落推进/收尾逻辑被跳过一次）。
 */

/**
 * ended 守卫状态机（与 AudioControllerHost 内联 ref 等价，可单测）。
 */
export interface AudioEndedGuard {
    /**
     * 解锁开始时置位（对应旧 `shouldIgnoreNextEndedRef.current = true`）。
     */
    armForUnlock: () => void;
    /**
     * 解锁 settled 时调用（finally）。
     */
    settleUnlock: () => void;
    /**
     * `ended` 到达时判定是否跳过（命中则消费标记，仅跳过一次）。
     * @returns 是否应跳过本次 ended
     */
    shouldSkipEnded: () => boolean;
}

/**
 * 新建 ended 守卫实例。
 * @returns 守卫实例
 */
export function createAudioEndedGuard(): AudioEndedGuard {
    // 中文注释：闭包标记等价于旧 ref，单测可驱动其完整生命周期。
    let ignoreNextEnded = false;
    return {
        armForUnlock: () => {
            ignoreNextEnded = true;
        },
        settleUnlock: () => {
            // 中文注释：R15 修复——解锁内 play→pause 永不产生 ended，
            // settled 时残留标记必为过期 state，必须清除，否则吞首个真实 ended。
            ignoreNextEnded = false;
        },
        shouldSkipEnded: () => {
            if (ignoreNextEnded) {
                ignoreNextEnded = false;
                return true;
            }
            return false;
        },
    };
}
