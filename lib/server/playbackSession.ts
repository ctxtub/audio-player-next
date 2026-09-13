/**
 * M5-04 Playback Session 服务端 Facade 骨架（spec §14 / §34 / §35）。
 *
 * 本文件是 Session API 在 server 侧的正式暴露层，逐步替代
 * lib/server/playbackProgress.ts（旧 CRUD Progress 实现保留兼容，不删除）。
 *
 * 定调：本项只冻结 API surface；完整业务实现按后续里程碑推进
 *（getAnchor / beginSession = M5-05，saveCheckpoint = M5-06 等）。
 * 因此逻辑未就绪处一律最小占位、严格 fail-closed：
 * - 绝不写坏数据（本文件当前不执行任何 Prisma 写操作）；
 * - 统一抛 TRPCError（调用方收到明确失败，而非静默脏读）。
 *
 * Router（lib/trpc/routers/playback.ts）只经由本 facade 对外提供
 * 7 个新 procedures，Subject 鉴权与 rate limit 仍由 router 层复用。
 */

import { TRPCError } from '@/lib/trpc/init';
import type { Subject } from '@/lib/server/subject';
import type {
  BeginPlaybackSessionInput,
  ClearPlaybackAnchorOutput,
  CompletePlaybackSessionInput,
  ClearPlaybackAnchorInput,
  GetPlaybackAnchorOutput,
  GetWorkPlaybackProgressBatchInput,
  GetWorkPlaybackProgressBatchOutput,
  PlaybackAnchorDTO,
  PromoteDraftPlaybackToWorkInput,
  SavePlaybackCheckpointInput,
  SavePlaybackCheckpointResult,
} from '@/lib/trpc/schemas/playback';

/**
 * 占位统一失败：Session 业务逻辑随 M5-05+ 落地前，所有调用 fail-closed。
 * 不读不写任何持久化状态。
 */
const notYetImplemented = (procedure: string): never => {
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: `[playback-session] ${procedure} 尚未就绪（M5-05+ 落地），fail-closed，拒绝脏写`,
  });
};

/** §15 playback.getAnchor：读取当前 Subject 唯一 Anchor（含 legacy repair，M5-05 落地）。 */
export const getPlaybackAnchorForSubject = async (
  subject: Subject,
): Promise<GetPlaybackAnchorOutput> => {
  void subject;
  return notYetImplemented('playback.getAnchor');
};

/** §16 playback.beginSession：创建新 Session 并落 Anchor（M5-05 落地）。 */
export const beginPlaybackSessionForSubject = async (
  subject: Subject,
  input: BeginPlaybackSessionInput,
): Promise<PlaybackAnchorDTO> => {
  void subject;
  void input;
  return notYetImplemented('playback.beginSession');
};

/** §17 playback.saveCheckpoint：Session 归属 + 单调守卫后更新 Anchor（M5-06 落地）。 */
export const savePlaybackCheckpointForSubject = async (
  subject: Subject,
  input: SavePlaybackCheckpointInput,
): Promise<SavePlaybackCheckpointResult> => {
  void subject;
  void input;
  return notYetImplemented('playback.saveCheckpoint');
};

/** §19 playback.completeSession：完播收尾（保留 ended Anchor，M5-0x 落地）。 */
export const completePlaybackSessionForSubject = async (
  subject: Subject,
  input: CompletePlaybackSessionInput,
): Promise<PlaybackAnchorDTO | null> => {
  void subject;
  void input;
  return notYetImplemented('playback.completeSession');
};

/** §21 playback.clearAnchor：仅清理当前 session（不匹配则 no-op，M5-0x 落地）。 */
export const clearPlaybackAnchorForSubject = async (
  subject: Subject,
  input: ClearPlaybackAnchorInput,
): Promise<ClearPlaybackAnchorOutput> => {
  void subject;
  void input;
  return notYetImplemented('playback.clearAnchor');
};

/** §24 playback.promoteDraftToWork：Draft→Work 提升（M5-0x 落地）。 */
export const promoteDraftPlaybackToWorkForSubject = async (
  subject: Subject,
  input: PromoteDraftPlaybackToWorkInput,
): Promise<PlaybackAnchorDTO> => {
  void subject;
  void input;
  return notYetImplemented('playback.promoteDraftToWork');
};

/** §22 playback.getWorkProgressBatch：M3 消费的 Work 进度批量视图（M5-0x 落地）。 */
export const getWorkPlaybackProgressBatchForSubject = async (
  subject: Subject,
  input: GetWorkPlaybackProgressBatchInput,
): Promise<GetWorkPlaybackProgressBatchOutput> => {
  void subject;
  void input;
  return notYetImplemented('playback.getWorkProgressBatch');
};
