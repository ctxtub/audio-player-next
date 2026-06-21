/**
 * 生成历史 Store
 *
 * 登录专属：仅登录态下持有服务端生成历史，无 localStorage 持久化。访客为空。
 */

import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';

import GlassToast from '@/components/ui/GlassToast';
import type { GenerationHistoryDTO } from '@/lib/trpc/schemas/generationHistory';
import {
  fetchMyGenerations,
  recordMyGeneration,
  removeMyGeneration,
} from '@/lib/client/generationHistory';

/** 生成历史记录（与服务端 DTO 同形）。 */
export type GenerationRecord = GenerationHistoryDTO;

/**
 * 生成历史 Store 的状态与动作。
 */
type GenerationHistoryState = {
  records: GenerationRecord[];
  /** 是否处于登录态（开启服务端读写）。 */
  syncEnabled: boolean;
};

type GenerationHistoryActions = {
  /** 登录后：拉取服务端生成历史，开启读写。 */
  initForUser: () => Promise<void>;
  /** 记录一次生成（仅登录态，后台写入成功后入列）。 */
  record: (prompt: string, storyText: string, voiceId?: string) => void;
  /** 删除某条历史（乐观本地 + 服务端）。 */
  remove: (id: number) => void;
  /** 登出：清空并关闭读写。 */
  reset: () => void;
};

export type GenerationHistoryStore = GenerationHistoryState & GenerationHistoryActions;

const generationHistoryStoreCreator: StateCreator<GenerationHistoryStore> = (set, get) => {
  /** initForUser 去重：进行中的拉取 Promise。 */
  let userInitPromise: Promise<void> | null = null;
  /** 账号代次：reset 自增，作废在途 initForUser 的回写（防跨账号数据回流）。 */
  let accountEpoch = 0;

  return {
    records: [],
    syncEnabled: false,

    initForUser: () => {
      if (get().syncEnabled) {
        return Promise.resolve();
      }
      if (userInitPromise) {
        return userInitPromise;
      }
      const epoch = accountEpoch; // 捕获进入代次
      userInitPromise = (async () => {
        const records = await fetchMyGenerations();
        if (epoch !== accountEpoch) {
          return; // 期间 reset 过 → 放弃回写，勿落旧账号数据 / 勿重开同步
        }
        set({ records, syncEnabled: true });
      })()
        .catch((error) => {
          console.warn('[generationHistoryStore] initForUser failed', error);
        })
        .finally(() => {
          if (epoch === accountEpoch) {
            userInitPromise = null; // 仅本代次才清句柄，勿清掉新登录起的请求
          }
        });
      return userInitPromise;
    },

    record: (prompt, storyText, voiceId) => {
      // 登录专属：未登录不记录
      if (!get().syncEnabled) {
        return;
      }
      const trimmedPrompt = prompt.trim();
      const trimmedStory = storyText.trim();
      if (!trimmedPrompt || !trimmedStory) {
        return;
      }
      recordMyGeneration({ prompt: trimmedPrompt, storyText: trimmedStory, voiceId })
        .then((dto) => {
          set((state) => ({ records: [dto, ...state.records] }));
        })
        .catch((error) => {
          console.warn('[generationHistoryStore] record failed', error);
          GlassToast.show({ icon: 'fail', content: '生成历史保存失败' });
        });
    },

    remove: (id) => {
      const prev = get().records;
      set({ records: prev.filter((r) => r.id !== id) });
      removeMyGeneration(id).catch((error) => {
        console.warn('[generationHistoryStore] remove failed', error);
        GlassToast.show({ icon: 'fail', content: '删除失败，稍后重试' });
        // 回滚乐观删除
        set({ records: prev });
      });
    },

    reset: () => {
      accountEpoch++; // 作废在途 initForUser 的回写
      userInitPromise = null; // 让重新登录能起新请求（与 configStore 一致）
      set({ records: [], syncEnabled: false });
    },
  };
};

/**
 * 生成历史 Store Hook。
 */
export const useGenerationHistoryStore = create<GenerationHistoryStore>()(
  devtools(generationHistoryStoreCreator, { name: 'generation-history-store' }),
);
