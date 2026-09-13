/**
 * 播放会话客户端（M5-04 正式暴露层，spec §34）。
 *
 * 包装 7 个新 Session procedures：
 * getAnchor / beginSession / saveCheckpoint / completeSession /
 * clearAnchor / promoteDraftToWork / getWorkProgressBatch。
 *
 * 旧 lib/client/playbackProgress.ts（getProgress / saveProgress /
 * clearProgress 包装）保留 adapter 一个迁移周期，不删除。
 */

import { trpc } from '@/lib/trpc/client';
import type {
  BeginPlaybackSessionInput,
  ClearPlaybackAnchorInput,
  ClearPlaybackAnchorOutput,
  CompletePlaybackSessionInput,
  GetPlaybackAnchorOutput,
  GetWorkPlaybackProgressBatchInput,
  GetWorkPlaybackProgressBatchOutput,
  PlaybackAnchorDTO,
  PromoteDraftPlaybackToWorkInput,
  SavePlaybackCheckpointInput,
  SavePlaybackCheckpointResult,
} from '@/lib/trpc/schemas/playback';

/** §15 playback.getAnchor：读取当前主体唯一 Anchor（无则 null）。 */
export const getPlaybackAnchor = async (): Promise<GetPlaybackAnchorOutput> => {
  return trpc.playback.getAnchor.query();
};

/** §16 playback.beginSession：创建新会话并落 Anchor。 */
export const beginPlaybackSession = async (
  input: BeginPlaybackSessionInput,
): Promise<PlaybackAnchorDTO> => {
  return trpc.playback.beginSession.mutate(input);
};

/** §17 playback.saveCheckpoint：同一 Session 内的段落进度上报。 */
export const savePlaybackCheckpoint = async (
  input: SavePlaybackCheckpointInput,
): Promise<SavePlaybackCheckpointResult> => {
  return trpc.playback.saveCheckpoint.mutate(input);
};

/** §19 playback.completeSession：完播收尾（保留 ended Anchor）。 */
export const completePlaybackSession = async (
  input: CompletePlaybackSessionInput,
): Promise<PlaybackAnchorDTO | null> => {
  return trpc.playback.completeSession.mutate(input);
};

/** §21 playback.clearAnchor：仅清理当前 session（不匹配则 no-op）。 */
export const clearPlaybackAnchor = async (
  input: ClearPlaybackAnchorInput,
): Promise<ClearPlaybackAnchorOutput> => {
  return trpc.playback.clearAnchor.mutate(input);
};

/** §24 playback.promoteDraftToWork：Draft→Work 提升。 */
export const promoteDraftPlaybackToWork = async (
  input: PromoteDraftPlaybackToWorkInput,
): Promise<PlaybackAnchorDTO> => {
  return trpc.playback.promoteDraftToWork.mutate(input);
};

/** §22 playback.getWorkProgressBatch：M3 消费的 Work 进度批量视图。 */
export const getWorkPlaybackProgressBatch = async (
  input: GetWorkPlaybackProgressBatchInput,
): Promise<GetWorkPlaybackProgressBatchOutput> => {
  return trpc.playback.getWorkProgressBatch.query(input);
};
