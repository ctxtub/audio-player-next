import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * GlassToast 打桩捕获器（读取末次 toast 用）。
 */
export interface ToastCapture {
    lastToast: { icon: string; content: string } | null;
}

/**
 * 新建空 toast 捕获器。
 * @returns 空捕获器
 */
export function createToastCapture(): ToastCapture {
    // 中文注释：每用例独立捕获器，避免跨用例串扰。
    return { lastToast: null };
}

/**
 * 预置 GlassToast 模块打桩（避免 store 触发真实 UI 依赖）。
 *
 * 与原各用例文件头内联 preamble 等价，统一收口于此；必须在导入任何 store 之前调用。
 * @param capture 可选捕获器（传入则记录末次 `show` 参数；不传则静默丢弃）
 */
export function installGlassToastStub(capture?: ToastCapture): void {
    // 中文注释：require 缓存劫持仅作用于当前进程的测试运行时。
    const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
    const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
    nodeRequire.cache[glassToastPath] = {
        id: glassToastPath,
        filename: glassToastPath,
        loaded: true,
        exports: {
            default: {
                show: (opts: { icon: string; content: string }) => {
                    if (capture) {
                        capture.lastToast = opts;
                    }
                },
                clear: () => {
                    if (capture) {
                        capture.lastToast = null;
                    }
                },
            },
        },
    } as unknown as NodeModule;
}
