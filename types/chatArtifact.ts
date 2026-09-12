/**
 * Chat Artifact 域契约类型定义（M4-01）。
 *
 * 核心设计：
 * 1. 彻底将 Message delivery 传输状态（ChatMessageDeliveryStatus）与 Artifact lifecycle 解耦。
 * 2. 状态机表达：draft -> complete -> promoting -> ready / promotion_failed，以及 draft -> interrupted。
 * 3. 严格契约约束：
 *    - draft / interrupted: 绝不能有 StoryWork（storyWorkId 恒为 undefined）；
 *    - complete: 内容已完整，资产尚未创建（storyWorkId 恒为 undefined）；
 *    - ready: 必须有正整数 storyWorkId；
 *    - promotion_failed: 保留 storyText 与 sourceMessageId，支持幂等重试。
 * 4. sourceMessageId 规则冻结：恒为产生该 Artifact 的 assistant message id (msg.id)。
 */

/**
 * Chat Artifact 状态枚举。
 */
export type ChatArtifactStatus =
  | 'draft'
  | 'complete'
  | 'promoting'
  | 'ready'
  | 'promotion_failed'
  | 'interrupted';

/**
 * 基础 Artifact 结构，定义所有生命周期状态共享的核心属性。
 */
export interface BaseChatArtifact {
  /** Artifact 唯一标识符。 */
  readonly id: string;
  /** Artifact 域类型，故事作品恒为 'story'。 */
  readonly artifactType: 'story';
  /**
   * 产生该 Artifact 的 assistant message id (msg.id)。
   * 与 M2 [userId/guestId, sourceMessageId] 幂等键对齐。
   */
  readonly sourceMessageId: string;
  /** 故事正文文本。 */
  readonly storyText: string;
  /** 可选故事标题。 */
  readonly title?: string;
  /** 触发该创作的 Prompt 文本。 */
  readonly prompt?: string;
  /** 故事配音 voiceId。 */
  readonly voiceId?: string;
  /** ISO 格式创建时间戳。 */
  readonly createdAt: string;
  /** ISO 格式最近更新时间戳。 */
  readonly updatedAt: string;
}

/**
 * 草稿状态：正文处于流式生成中。
 * 契约：storyWorkId 恒为 undefined。
 */
export interface DraftChatArtifact extends BaseChatArtifact {
  readonly status: 'draft';
  readonly storyWorkId?: undefined;
}

/**
 * 文本完成状态：故事正文已完整，但资产尚未创建。
 * 契约：storyWorkId 恒为 undefined。
 */
export interface CompleteChatArtifact extends BaseChatArtifact {
  readonly status: 'complete';
  readonly storyWorkId?: undefined;
}

/**
 * 入库中状态：正在调用 library.create 创建 StoryWork。
 * 契约：storyWorkId 恒为 undefined。
 */
export interface PromotingChatArtifact extends BaseChatArtifact {
  readonly status: 'promoting';
  readonly storyWorkId?: undefined;
}

/**
 * 就绪状态：已成功创建 StoryWork 资产。
 * 契约：必须持有合法正整数 storyWorkId。
 */
export interface ReadyChatArtifact extends BaseChatArtifact {
  readonly status: 'ready';
  readonly storyWorkId: number;
}

/**
 * 入库失败状态：调用 library.create 遇到网络或服务端异常。
 * 契约：
 * 1. 保留原始 storyText 与 sourceMessageId；
 * 2. storyWorkId 恒为 undefined；
 * 3. 可选记录 error 描述，支持直接重试 promotion。
 */
export interface PromotionFailedChatArtifact extends BaseChatArtifact {
  readonly status: 'promotion_failed';
  readonly storyWorkId?: undefined;
  readonly error?: string;
}

/**
 * 生成中断状态：流式生成被用户主动取消或发生致命异常。
 * 契约：storyWorkId 恒为 undefined。
 */
export interface InterruptedChatArtifact extends BaseChatArtifact {
  readonly status: 'interrupted';
  readonly storyWorkId?: undefined;
  readonly reason?: string;
}

/**
 * Chat Artifact 状态机联合类型。
 */
export type ChatArtifact =
  | DraftChatArtifact
  | CompleteChatArtifact
  | PromotingChatArtifact
  | ReadyChatArtifact
  | PromotionFailedChatArtifact
  | InterruptedChatArtifact;

// ============================================================================
// 类型守卫
// ============================================================================

/**
 * 判断是否为草稿状态 Artifact。
 */
export const isDraftArtifact = (
  artifact: ChatArtifact
): artifact is DraftChatArtifact => artifact.status === 'draft';

/**
 * 判断是否为文本完成状态 Artifact。
 */
export const isCompleteArtifact = (
  artifact: ChatArtifact
): artifact is CompleteChatArtifact => artifact.status === 'complete';

/**
 * 判断是否为入库中状态 Artifact。
 */
export const isPromotingArtifact = (
  artifact: ChatArtifact
): artifact is PromotingChatArtifact => artifact.status === 'promoting';

/**
 * 判断是否为就绪状态（持有合法 storyWorkId）Artifact。
 */
export const isReadyArtifact = (
  artifact: ChatArtifact
): artifact is ReadyChatArtifact =>
  artifact.status === 'ready' &&
  typeof artifact.storyWorkId === 'number' &&
  Number.isInteger(artifact.storyWorkId) &&
  artifact.storyWorkId > 0;

/**
 * 判断是否为入库失败状态 Artifact。
 */
export const isPromotionFailedArtifact = (
  artifact: ChatArtifact
): artifact is PromotionFailedChatArtifact =>
  artifact.status === 'promotion_failed';

/**
 * 判断是否为生成中断状态 Artifact。
 */
export const isInterruptedArtifact = (
  artifact: ChatArtifact
): artifact is InterruptedChatArtifact => artifact.status === 'interrupted';

/**
 * 校验任意未知输入是否符合 ChatArtifact 结构基本形态。
 */
export const isChatArtifact = (value: unknown): value is ChatArtifact => {
  if (value === null || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  if (c.artifactType !== 'story') return false;
  if (typeof c.id !== 'string' || c.id.trim() === '') return false;
  if (typeof c.sourceMessageId !== 'string' || c.sourceMessageId.trim() === '') return false;
  if (typeof c.storyText !== 'string') return false;
  if (typeof c.createdAt !== 'string' || typeof c.updatedAt !== 'string') return false;

  const validStatuses: ChatArtifactStatus[] = [
    'draft',
    'complete',
    'promoting',
    'ready',
    'promotion_failed',
    'interrupted',
  ];
  if (!validStatuses.includes(c.status as ChatArtifactStatus)) return false;

  if (c.status === 'ready') {
    return (
      typeof c.storyWorkId === 'number' &&
      Number.isInteger(c.storyWorkId) &&
      c.storyWorkId > 0
    );
  }

  // 所有非 ready 状态，严禁出现合法 storyWorkId
  return c.storyWorkId === undefined;
};
