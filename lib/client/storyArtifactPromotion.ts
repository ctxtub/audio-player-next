/**
 * StoryWork Promotion Adapter（M4-03）。
 *
 * 唯一的 promotion 通道：CompleteChatArtifact → Promotion Adapter → libraryClient.create(...) → StoryWorkDetailDTO。
 * 本步仍然不要自动触发 promotion（orchestration 留 M4-04）；adapter 只负责 I/O。
 *
 * 薄层契约：
 * 1. 只接受 complete / promotion_failed（retry source）且携带非空 prompt 快照；
 *    draft / interrupted / promoting / ready / legacy，以及缺失 mandatory
 *    prompt snapshot 的 complete / promotion_failed，一律 fail-fast。
 * 2. 构造 frozen LibraryCreateInput { title, prompt, storyText, voiceId, sourceMessageId } → libraryClient.create。
 * 3. 不自行造 client-side idempotency key；幂等完全由 M2 [sourceMessageId + storyText hash] 保障。
 * 4. 同 sourceMessageId + 不同 storyText 的 CONFLICT 原样向上暴露；不吞错、不自动换 sourceMessageId。
 * 5. promotion 时严禁重新读取当前 Settings；只消费 Artifact 生成开始时冻结的 prompt/voiceId 快照。
 * 6. 只能消费 frozen libraryClient.create；严禁 import server/Prisma/raw trpc。
 * 7. 不负责把 Artifact 改成 promoting/ready/failed——那是 M4-04 orchestration 的职责。
 */

import type {
  ChatArtifact,
  CompleteChatArtifact,
  PromotionFailedChatArtifact,
} from '@/types/chatArtifact';
import type {
  LibraryCreateInput,
  StoryWorkDetailDTO,
} from '@/lib/trpc/schemas/library';
import { libraryClient } from '@/lib/client/library';

/**
 * 可 promotion 的 Artifact 狭窄类型：仅 complete 与 promotion_failed，
 * 且必须携带生成开始时冻结的 mandatory prompt snapshot（非空字符串）。
 * M4-01 Artifact contract 里 prompt 是 optional，缺 snapshot 的合法状态机
 * 对象必须在此 fail-fast，绝不触达 library.create。
 */
export type PromotableChatArtifact = (
  | CompleteChatArtifact
  | PromotionFailedChatArtifact
) & {
  readonly prompt: string;
};

/**
 * library.create 函数签名（与 frozen facade 一致，便于测试注入）。
 */
export type PromotionCreateFn = (input: LibraryCreateInput) => Promise<StoryWorkDetailDTO>;

/**
 * promotion 依赖注入（测试用隔离桩；生产默认走 frozen libraryClient.create）。
 */
export interface PromotionAdapterDeps {
  readonly create?: PromotionCreateFn;
}

/**
 * 判断未知输入是否为可 promotion 的 Artifact（complete / promotion_failed
 * 且携带非空 prompt 快照）。禁止在 adapter 里自动补 prompt（禁止 prompt=''、
 * prompt=storyText、prompt=当前 inputValue、从消息列表重新猜）——缺 snapshot
 * 必须 fail-fast（重新猜 prompt 会破坏生成时快照契约）。
 */
function isPromotableArtifact(value: unknown): value is PromotableChatArtifact {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.artifactType !== 'story') {
    return false;
  }
  if (
    candidate.status !== 'complete' &&
    candidate.status !== 'promotion_failed'
  ) {
    return false;
  }
  // mandatory promotion snapshot：prompt 必须是非空字符串。
  return (
    typeof candidate.prompt === 'string' && candidate.prompt.trim().length > 0
  );
}

/**
 * 对 Artifact 做 fail-fast 门控，返回可 promotion 的窄类型。
 * 非 complete / promotion_failed（含 draft / interrupted / promoting / ready / legacy）一律抛错，
 * status 合法但缺失 mandatory prompt snapshot（undefined / 非字符串 / 空白）同样抛错，
 * 且绝不触达 library.create。
 */
export function assertPromotableArtifact(
  artifact: unknown,
): asserts artifact is PromotableChatArtifact {
  if (isPromotableArtifact(artifact)) {
    return;
  }
  if (artifact === null || typeof artifact !== 'object') {
    throw new Error(
      'Promotion adapter 拒绝：输入必须为 complete / promotion_failed ChatArtifact',
    );
  }
  const candidate = artifact as Record<string, unknown>;
  const status = candidate.status;
  if (candidate.artifactType !== 'story' || typeof status !== 'string') {
    throw new Error(
      'Promotion adapter 拒绝：Legacy StoryCard 与非故事内容不可 promotion（仅 complete / promotion_failed 可入库）',
    );
  }
  if (status !== 'complete' && status !== 'promotion_failed') {
    throw new Error(
      `Promotion adapter 拒绝：status=${JSON.stringify(status)} 不可 promotion（仅 complete / promotion_failed 可入库）`,
    );
  }
  // status 合法但缺 mandatory promotion snapshot：fail-fast，禁止自动补 prompt。
  throw new Error(
    'Promotion adapter 拒绝：缺失 mandatory promotion snapshot（prompt 为空），不可 promotion（fail-fast，未触达 library.create；禁止自动补 prompt）',
  );
}

/**
 * 由冻结快照构造 LibraryCreateInput（精确映射五字段，不增不减）。
 * prompt / voiceId 恒取 Artifact 生成开始时冻结值，严禁回读当前 Settings。
 */
export function buildPromotionInput(
  artifact: PromotableChatArtifact,
): LibraryCreateInput {
  return {
    title: artifact.title,
    prompt: artifact.prompt,
    storyText: artifact.storyText,
    voiceId: artifact.voiceId,
    sourceMessageId: artifact.sourceMessageId,
  };
}

/**
 * 将 Complete / PromotionFailed Artifact 提升为 StoryWork。
 * 薄 I/O：门控 → 构造 frozen input → 透传 libraryClient.create；错误原样上抛。
 *
 * @param artifact 必须为 complete（初次）或 promotion_failed（幂等重试源）。
 * @param deps 可选注入的 create 实现；缺省为 frozen libraryClient.create。
 * @returns 服务端返回的 StoryWorkDetailDTO。
 */
export async function promoteStoryArtifact(
  artifact: ChatArtifact | unknown,
  deps?: PromotionAdapterDeps,
): Promise<StoryWorkDetailDTO> {
  assertPromotableArtifact(artifact);
  const input = buildPromotionInput(artifact);
  const create = deps?.create ?? libraryClient.create;
  return create(input);
}
