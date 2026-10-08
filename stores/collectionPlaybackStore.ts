import { create } from 'zustand';
/** 回听队列只保存正式身份；刷新不自动恢复连播。 */
export const useCollectionPlaybackStore = create<{
  collectionId: string | null;
  works: Array<{ id: number; title: string }>;
  index: number;
  epoch: number;
  error: string | null;
  preparingWorkId: number | null;
  readyWorkId: number | null;
  clear: () => void;
}>((set) => ({
  collectionId: null, works: [], index: -1, epoch: 0, error: null, preparingWorkId: null, readyWorkId: null,
  clear: () => set((state) => ({ collectionId: null, works: [], index: -1, error: null, preparingWorkId: null, readyWorkId: null, epoch: state.epoch + 1 })),
}));
