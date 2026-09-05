/**
 * 断点播放进度客户端
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
