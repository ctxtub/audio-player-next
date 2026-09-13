/**
 * 断点播放进度客户端
 *
 * @deprecated M5-09 Legacy Cutover（spec §34）：旧 compatibility procedures
 *（getProgress/saveProgress/clearProgress）保留一个迁移周期（M9 删除）。
 * 新客户端一律使用 lib/client/playbackSession.ts 正式暴露层：
 * getPlaybackAnchor / beginPlaybackSession / savePlaybackCheckpoint /
 * completePlaybackSession / clearPlaybackAnchor / promoteDraftPlaybackToWork /
 * getWorkPlaybackProgressBatch。本文件行为不动，仅作 adapter。
 *
 * 使用 tRPC 读取、保存与清除当前主体（用户或具名访客）的段落播放进度。
 */

import { trpc } from '@/lib/trpc/client';
import type {
  PlaybackProgressDTO,
  SavePlaybackProgressInput,
} from '@/lib/trpc/schemas/playback';

export type MyPlaybackProgressResponse = PlaybackProgressDTO | null;

/**
 * 拉取当前主体的断点播放进度。
 */
export const fetchPlaybackProgress = async (): Promise<PlaybackProgressDTO | null> => {
  return trpc.playback.getProgress.query();
};

/**
 * 保存当前主体的断点播放进度。
 */
export const savePlaybackProgress = async (
  input: SavePlaybackProgressInput
): Promise<PlaybackProgressDTO> => {
  return trpc.playback.saveProgress.mutate(input);
};

/**
 * 清除当前主体的断点播放进度。
 */
export const clearPlaybackProgress = async (): Promise<{ success: true }> => {
  return trpc.playback.clearProgress.mutate();
};
