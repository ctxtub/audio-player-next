'use client';

import { useEffect } from 'react';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { isBrowserTestRuntime } from './probeFlag';

/**
 * M5-10 fixup 最小真实 browser 闭环稳定挂点（评审 Blocking 1）。
 *
 * M5-10 fixup-2（E2E-only default-off）：本组件仅在 browser test runtime
 *（构建时显式注入 `NEXT_PUBLIC_E2E_PLAYBACK_PROBE=1`）挂载；普通 production
 * runtime 由 layout 侧条件挂载拦截（组件执行路径不进），此处再设内守卫双保险
 *（fail closed：开关缺席/非法值一律 return null，不写 window global、不建 DOM 锚点）。
 *
 * 仅为 L3 聚合场景暴露只读快照 + 真实运行时入口（Session Flow / Transport），
 * 不改变任何产品行为：渲染 null（另附隐藏 data-testid 锚点供轮询），无日志、
 * 无网络、无样式影响；失败静默（绝不阻断产品渲染）。
 *
 * 覆盖：
 * - Scenario A（导航存活）：sessionId / source / audioCount / beginSession 计数（测试侧网络计数）；
 * - Scenario B（暂停/刷新/恢复）：status=ready + transport idle + 同 sessionId resume。
 * Scenario C（stale async TTS 延迟注入）在 browser harness 难稳定注入（mock TTS 为
 * 即时固定 MP3，无可编程延迟面；为其加延迟钩需改运行时本体，违背“本体保持现状”
 * 边界），故保留既有 L1 确定性覆盖（exec-playback-runtime-orchestration §50），此处不设 browser 版。
 */
export default function PlaybackSessionProbe(): null {
  // 中文注释：双保险之二——组件内守卫（layout 侧已条件挂载，此处 fail closed 兜底）。
  const enabled = isBrowserTestRuntime();
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let anchorEl: HTMLDivElement | null = null;
    const w = window as unknown as Record<string, unknown>;
    void (async () => {
      try {
        const flow = await import('@/app/services/playbackSessionFlow');
        if (disposed) return;
        const snapshot = (): Record<string, unknown> => {
          try {
            const session = usePlaybackSessionStore.getState();
            const transport = usePlaybackStore.getState();
            const audioCount = document.querySelectorAll('audio').length;
            return {
              probe: 'ready',
              sessionId: session.sessionId,
              source: session.source,
              status: session.status,
              continuationMode: session.continuationMode,
              nextParagraphIndex: session.nextParagraphIndex,
              totalParagraphs: session.totalParagraphs,
              lastCompletedParagraphIndex: session.lastCompletedParagraphIndex,
              transport: {
                isPlaying: transport.isPlaying,
                hasAudioUrl: transport.currentAudioUrl !== null,
                audioUrl: transport.currentAudioUrl,
                currentTime: transport.currentTime,
                duration: transport.duration,
                hasController: transport.audioController !== null,
              },
              audioCount,
            };
          } catch {
            return { probe: 'error' };
          }
        };
        w.__M5PlaybackProbe = {
          snapshot,
          beginWork: async (workId: number, mode: 'resume' | 'restart' = 'resume'): Promise<Record<string, unknown>> => {
            await flow.beginPlayback({ source: { kind: 'work', workId }, mode, speed: 1 });
            return snapshot();
          },
          playParagraph: async (index: number): Promise<Record<string, unknown>> => {
            await flow.playParagraph(index, { explicit: true });
            return snapshot();
          },
          pause: (): Record<string, unknown> => {
            flow.pausePlayback();
            return snapshot();
          },
          resume: async (): Promise<Record<string, unknown>> => {
            await flow.resumePlayback();
            return snapshot();
          },
          saveCheckpointNow: async (): Promise<Record<string, unknown>> => {
            await usePlaybackSessionStore.getState().saveCheckpointImmediate();
            return snapshot();
          },
        };
        anchorEl = document.createElement('div');
        anchorEl.setAttribute('data-testid', 'm5-playback-probe');
        anchorEl.setAttribute('data-probe', 'ready');
        anchorEl.style.display = 'none';
        document.body.appendChild(anchorEl);
      } catch {
        // 静默：探针失败绝不影响产品行为。
      }
    })();
    return () => {
      disposed = true;
      try {
        delete w.__M5PlaybackProbe;
      } catch {
        // 忽略清理异常。
      }
      try {
        anchorEl?.remove();
      } catch {
        // 忽略清理异常。
      }
    };
  }, [enabled]);
  if (!enabled) return null;
  return null;
}
