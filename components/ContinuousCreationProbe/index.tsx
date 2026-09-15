'use client';

import { useEffect } from 'react';
import { isBrowserTestRuntime } from '@/components/PlaybackSessionProbe/probeFlag';
import { useContinuousCreationStore } from '@/stores/continuousCreationStore';
import {
  __setContinuousCreationGeneratorForTests,
  consumePreparedNextWork,
  handleTrackEnded,
  hasPreparedNextWork,
  reportContinuousAudioActive,
  resetContinuousCreationRuntime,
  scheduleNextWork,
} from '@/app/services/continuousCreationFlow';

type NextWork = { messageId: string; audioUrl: string; content: string };

/**
 * M9-C1 T2 targeted L3 连续创作编排探针（E2E-only default-off）。
 *
 * 与 `PlaybackSessionProbe` 同一开关（`NEXT_PUBLIC_E2E_PLAYBACK_PROBE=1`）：
 * 普通 production runtime 不挂载、无 window global、无 DOM 锚点（fail closed）。
 * 仅暴露**真实编排模块的既有函数**（store 动作 + `continuousCreationFlow` 服务），
 * 不复制状态机、不改产品语义，供 L3 在真实浏览器进程内驱动
 * 「默认开启 → 自动下一任务 → 预算耗尽停止 → 新建创作静默且旧响应不复活」链路。
 */
export default function ContinuousCreationProbe(): null {
  const enabled = isBrowserTestRuntime();
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let anchorEl: HTMLDivElement | null = null;
    const w = window as unknown as Record<string, unknown>;
    void (async () => {
      try {
        const store = () => useContinuousCreationStore.getState();
        const snapshot = (): Record<string, unknown> => ({
          probe: 'ready',
          status: store().status,
          epoch: store().epoch,
          enabled: store().enabled,
          budgetMs: store().budgetMs,
          remainingMs: store().remainingMs,
          hasNextJob: store().hasNextJob(),
          hasPreparedNextWork: hasPreparedNextWork(),
          collectionId: store().collectionId,
        });
        // 中文注释：deferred 生成器注入——scheduleNextWork 挂起，等场景显式 resolve/reject。
        let pendingResolve: ((value: NextWork) => void) | null = null;
        w.__M9ContinuousCreationProbe = {
          snapshot,
          resetForNewCreation: (input: {
            budgetMs: number | null;
            collectionId: string;
            epoch: number;
          }): Record<string, unknown> => {
            resetContinuousCreationRuntime();
            store().resetForNewCreation({
              collectionId: input.collectionId,
              budgetMinutes:
                input.budgetMs === null ? 0 : input.budgetMs / 60_000,
              epoch: input.epoch,
            });
            return snapshot();
          },
          setBudget: (ms: number): Record<string, unknown> => {
            store().setBudget(ms);
            return snapshot();
          },
          disable: (): Record<string, unknown> => {
            store().disable();
            return snapshot();
          },
          enable: (): Record<string, unknown> => {
            store().enable();
            return snapshot();
          },
          reset: (): Record<string, unknown> => {
            store().reset();
            return snapshot();
          },
          scheduleNextWork: async (input: {
            epoch: number;
            remainingTrackMs?: number;
          }): Promise<Record<string, unknown>> => {
            __setContinuousCreationGeneratorForTests(
              () =>
                new Promise<NextWork>((resolve) => {
                  pendingResolve = resolve;
                }),
            );
            const ok = await scheduleNextWork({
              epoch: input.epoch,
              nowPlaying: true,
              remainingTrackMs: input.remainingTrackMs ?? 1_000,
            });
            return { ok, ...snapshot() };
          },
          resolveNextWork: (work: NextWork): Record<string, unknown> => {
            const resolve = pendingResolve;
            pendingResolve = null;
            resolve?.(work);
            return snapshot();
          },
          reportAudioActive: (active: boolean): Record<string, unknown> => {
            reportContinuousAudioActive(active);
            return snapshot();
          },
          handleTrackEnded: (epoch: number): Record<string, unknown> => {
            const work = handleTrackEnded(epoch);
            return { work, ...snapshot() };
          },
          consumePreparedNextWork: (epoch: number): unknown =>
            consumePreparedNextWork(epoch),
        };
        anchorEl = document.createElement('div');
        anchorEl.setAttribute('data-testid', 'm9-continuous-creation-probe');
        anchorEl.setAttribute('data-probe', 'ready');
        anchorEl.style.display = 'none';
        document.body.appendChild(anchorEl);
      } catch {
        // 静默：探针失败绝不影响产品行为。
      }
    })();
    return () => {
      disposed = true;
      void disposed;
      __setContinuousCreationGeneratorForTests(null);
      resetContinuousCreationRuntime();
      try {
        delete w.__M9ContinuousCreationProbe;
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
