/** Formal Work audio uses a single authorized Asset; Draft audio is separate. */
import { trpc } from '@/lib/trpc/client';
import { getQueryClient } from '@/lib/client/queryClient';

/**
 *  单轨 ensure（`{ workId, sessionId }`，无 segmentIndex）。
 * 一个 Work 返回一个授权 Asset URL，供卡片/Mini/Expanded 共用同一时间轴。
 */
export const ensureAsset = async (input: {
  workId: number;
  sessionId: string;
}, signal?: AbortSignal): Promise<import('@/lib/trpc/schemas/storyAudio').EnsureStoryAudioOutput> => {
  const result = await trpc.storyAudio.ensure.mutate(input, { signal });
  // 准备完成后让当前可见列表和正文读取正式音频投影；不改变播放身份或队列。
  if (result.status === 'ready' && !signal?.aborted) {
    const queryClient = getQueryClient();
    // 只依赖查询族前缀，避免 API 门面反向依赖包含 Store 的 React 查询 hooks。
    void queryClient.invalidateQueries({ queryKey: ['library'] });
    void queryClient.invalidateQueries({ queryKey: ['collections'] });
  }
  return result;
};

/**  单轨投影读取（只读）。 */
export const getProjection = async (input: {
  workId: number;
}): Promise<import('@/lib/trpc/schemas/storyAudio').StoryAudioAssetProjection> => {
  return trpc.storyAudio.getProjection.query(input);
};

/**  秒级进度写入口。 */
export const saveProgress = async (input: {
  workId: number;
  sessionId: string;
  positionMs: number;
  durationMs?: number | null;
  force?: boolean;
}): Promise<{ written: boolean }> => {
  return trpc.storyAudio.saveProgress.mutate(input);
};
