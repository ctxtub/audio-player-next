/**
 * 播放意图 Store。
 *
 * 只承载尚未进入 PlaybackSession 的短暂用户可见意图。目前唯一状态是首篇
 * 自动播放：消息流已结束，但 Work 晋升、保存或 Session begin 仍在途中。
 * 正式播放状态仍以 PlaybackSessionStore + PlaybackStore 为唯一来源。
 */
import { create } from 'zustand';

type PlaybackIntentState = {
  pendingAutoplayMessageId: string | null;
  beginAutoplay: (messageId: string) => void;
  clearAutoplay: (messageId?: string) => void;
};

export const usePlaybackIntentStore = create<PlaybackIntentState>()((set) => ({
  pendingAutoplayMessageId: null,
  beginAutoplay: (messageId) => {
    set({ pendingAutoplayMessageId: messageId });
  },
  clearAutoplay: (messageId) => {
    set((state) => {
      if (messageId !== undefined && state.pendingAutoplayMessageId !== messageId) {
        return state;
      }
      return { pendingAutoplayMessageId: null };
    });
  },
}));
