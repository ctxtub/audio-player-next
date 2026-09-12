/**
 * Chat Artifact 纯状态机与领域转换函数（M4-01）。
 *
 * 设计原则：
 * 1. 纯函数设计：无外部副作用，不依赖网络、数据库、React 或任何全局状态。
 * 2. 状态机严格约束：
 *    - draft -> complete: 文本生成结束，等待资产落盘
 *    - draft -> interrupted: 用户取消或流式中断
 *    - complete -> promoting: 触发 library.create
 *    - promoting -> ready: library.create 成功，绑定正整数 storyWorkId
 *    - promoting -> promotion_failed: library.create 失败，保留完整内容与 sourceMessageId
 *    - promotion_failed -> promoting: 幂等重试入库
 * 3. 任何非法状态跃迁均显式抛错，不隐式吃掉。
 * 4. 严格断言不变量：draft/interrupted 绝不得含有 storyWorkId；ready 必须含有正整数 storyWorkId。
 */

import type {
  ChatArtifact,
  ChatArtifactStatus,
  CompleteChatArtifact,
  DraftChatArtifact,
  InterruptedChatArtifact,
  PromotingChatArtifact,
  PromotionFailedChatArtifact,
  ReadyChatArtifact,
} from '../../types/chatArtifact';
import type { StoryCardPart } from '../../types/chat';

// ============================================================================
// 合法状态转移表
// ============================================================================

const ALLOWED_TRANSITIONS: Readonly<Record<ChatArtifactStatus, ReadonlySet<ChatArtifactStatus>>> = {
  draft: new Set<ChatArtifactStatus>(['complete', 'interrupted']),
  complete: new Set<ChatArtifactStatus>(['promoting']),
  promoting: new Set<ChatArtifactStatus>(['ready', 'promotion_failed']),
  ready: new Set<ChatArtifactStatus>([]), // ready 为最终稳定态，不可回退或二次 promotion
  promotion_failed: new Set<ChatArtifactStatus>(['promoting']), // 允许重试
  interrupted: new Set<ChatArtifactStatus>([]), // interrupted 为终态，不可直接 promotion
};

/**
 * 判断两个状态之间的转移是否合法。
 */
export function isAllowedTransition(
  from: ChatArtifactStatus,
  to: ChatArtifactStatus
): boolean {
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed ? allowed.has(to) : false;
}

// ============================================================================
// 不变量校验与断言
// ============================================================================

export interface ArtifactValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * 校验 Artifact 是否满足当前生命周期状态下的全量不变量。
 */
export function validateArtifactInvariants(
  artifact: unknown
): ArtifactValidationResult {
  const errors: string[] = [];

  if (artifact === null || typeof artifact !== 'object') {
    return { valid: false, errors: ['Artifact 必须为非空对象'] };
  }

  const a = artifact as Record<string, unknown>;

  if (a.artifactType !== 'story') {
    errors.push(`artifactType 必须恒为 'story'，实际为 ${JSON.stringify(a.artifactType)}`);
  }

  if (typeof a.id !== 'string' || a.id.trim() === '') {
    errors.push('id 必须为非空字符串');
  }

  if (typeof a.sourceMessageId !== 'string' || a.sourceMessageId.trim() === '') {
    errors.push('sourceMessageId 必须为非空字符串（产生该 Artifact 的 assistant 消息 id）');
  }

  if (typeof a.storyText !== 'string') {
    errors.push('storyText 必须为字符串');
  }

  if (typeof a.createdAt !== 'string' || a.createdAt.trim() === '') {
    errors.push('createdAt 必须为 ISO 时间戳字符串');
  }

  if (typeof a.updatedAt !== 'string' || a.updatedAt.trim() === '') {
    errors.push('updatedAt 必须为 ISO 时间戳字符串');
  }

  const validStatuses: readonly ChatArtifactStatus[] = [
    'draft',
    'complete',
    'promoting',
    'ready',
    'promotion_failed',
    'interrupted',
  ];

  if (!validStatuses.includes(a.status as ChatArtifactStatus)) {
    errors.push(`status 非法：${JSON.stringify(a.status)}`);
    return { valid: false, errors };
  }

  const status = a.status as ChatArtifactStatus;

  // 状态特定不变量
  switch (status) {
    case 'draft':
      if (a.storyWorkId !== undefined) {
        errors.push('草稿状态（draft）严禁包含 storyWorkId');
      }
      break;

    case 'interrupted':
      if (a.storyWorkId !== undefined) {
        errors.push('中断状态（interrupted）严禁包含 storyWorkId');
      }
      break;

    case 'complete':
      if (a.storyWorkId !== undefined) {
        errors.push('内容完成态（complete）资产尚未创建，storyWorkId 必须为 undefined');
      }
      if (typeof a.storyText === 'string' && a.storyText.trim() === '') {
        errors.push('内容完成态（complete）故事文本不得为空');
      }
      break;

    case 'promoting':
      if (a.storyWorkId !== undefined) {
        errors.push('入库中状态（promoting）资产尚未落地，storyWorkId 必须为 undefined');
      }
      if (typeof a.storyText === 'string' && a.storyText.trim() === '') {
        errors.push('入库中状态（promoting）故事文本不得为空');
      }
      break;

    case 'ready':
      if (
        typeof a.storyWorkId !== 'number' ||
        !Number.isInteger(a.storyWorkId) ||
        a.storyWorkId <= 0
      ) {
        errors.push(
          `就绪状态（ready）必须包含合法正整数 storyWorkId，实际为 ${JSON.stringify(a.storyWorkId)}`
        );
      }
      if (typeof a.storyText === 'string' && a.storyText.trim() === '') {
        errors.push('就绪状态（ready）故事文本不得为空');
      }
      break;

    case 'promotion_failed':
      if (a.storyWorkId !== undefined) {
        errors.push('入库失败态（promotion_failed）storyWorkId 必须为 undefined');
      }
      if (typeof a.storyText === 'string' && a.storyText.trim() === '') {
        errors.push('入库失败态（promotion_failed）故事文本不得为空（需保留原文本以便重试）');
      }
      break;
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 断言 Artifact 不变量，若不满足则直接抛出 TypeError / Error。
 */
export function assertArtifactInvariants(
  artifact: unknown
): asserts artifact is ChatArtifact {
  const result = validateArtifactInvariants(artifact);
  if (!result.valid) {
    throw new Error(
      `Artifact 不变量破坏：\n- ${result.errors.join('\n- ')}`
    );
  }
}

// ============================================================================
// 状态能力谓词
// ============================================================================

/**
 * 判断 Artifact 当前是否允许发起入库（从 complete 初次入库或从 promotion_failed 幂等重试）。
 */
export function canPromote(artifact: ChatArtifact): boolean {
  return artifact.status === 'complete' || artifact.status === 'promotion_failed';
}

/**
 * 判断 Artifact 是否处于允许重试入库的状态。
 */
export function canRetryPromotion(artifact: ChatArtifact): boolean {
  return artifact.status === 'promotion_failed';
}

/**
 * 判断 Artifact 当前是否可被中断（仅草稿生成中可中断）。
 */
export function canInterrupt(artifact: ChatArtifact): boolean {
  return artifact.status === 'draft';
}

/**
 * 判断 Artifact 是否已进入不可变终态（ready 成功入库，或 interrupted 生成中断）。
 */
export function isTerminalArtifact(artifact: ChatArtifact): boolean {
  return artifact.status === 'ready' || artifact.status === 'interrupted';
}

/**
 * 获取用于 M2 library.create 幂等关联的 sourceMessageId。
 * 契约冻结：恒为产生该 Artifact 的 assistant message id (msg.id)。
 */
export function getSourceMessageId(artifact: ChatArtifact): string {
  return artifact.sourceMessageId;
}

/**
 * 校验两个 Artifact 是否源自同一条助手生成消息。
 */
export function isSameSourceArtifact(a: ChatArtifact, b: ChatArtifact): boolean {
  return (
    typeof a.sourceMessageId === 'string' &&
    a.sourceMessageId !== '' &&
    a.sourceMessageId === b.sourceMessageId
  );
}

// ============================================================================
// 纯状态机转换函数
// ============================================================================

/**
 * 创建初始草稿 Artifact。
 */
export function createDraftArtifact(params: {
  readonly id?: string;
  readonly sourceMessageId: string;
  readonly initialText?: string;
  readonly title?: string;
  readonly prompt?: string;
  readonly voiceId?: string;
  readonly createdAt?: string;
}): DraftChatArtifact {
  const trimmedSourceId = params.sourceMessageId ? params.sourceMessageId.trim() : '';
  if (!trimmedSourceId) {
    throw new Error('创建 Artifact 草稿必须提供非空 sourceMessageId（助手消息 id）');
  }

  const now = params.createdAt ?? new Date().toISOString();
  const id = params.id ?? `artifact-${trimmedSourceId}-${Date.now()}`;

  const artifact: DraftChatArtifact = {
    id,
    artifactType: 'story',
    status: 'draft',
    sourceMessageId: trimmedSourceId,
    storyText: params.initialText ?? '',
    title: params.title,
    prompt: params.prompt,
    voiceId: params.voiceId,
    createdAt: now,
    updatedAt: now,
  };

  assertArtifactInvariants(artifact);
  return artifact;
}

/**
 * 流式追加文本片段（仅允许在 draft 状态下执行）。
 */
export function appendDraftChunk(
  artifact: DraftChatArtifact,
  delta: string,
  now?: string
): DraftChatArtifact {
  if (artifact.status !== 'draft') {
    throw new Error(
      `只能向 draft 状态追加文本，当前状态为 ${artifact.status}`
    );
  }

  const timestamp = now ?? new Date().toISOString();
  const updated: DraftChatArtifact = {
    ...artifact,
    storyText: artifact.storyText + delta,
    updatedAt: timestamp,
  };

  assertArtifactInvariants(updated);
  return updated;
}

/**
 * 标记故事正文完成（draft -> complete）。
 * 若提供 finalStoryText 则使用该权威文本覆盖客户端流式累积文本。
 */
export function completeArtifact(
  artifact: DraftChatArtifact,
  params?: {
    readonly finalStoryText?: string;
    readonly title?: string;
  },
  now?: string
): CompleteChatArtifact {
  if (!isAllowedTransition(artifact.status, 'complete')) {
    throw new Error(
      `非法状态转移：不能从 ${artifact.status} 转到 complete`
    );
  }

  const storyText = (params?.finalStoryText ?? artifact.storyText).trim();
  if (!storyText) {
    throw new Error('标记故事完成失败：故事正文不能为空');
  }

  const timestamp = now ?? new Date().toISOString();
  const completed: CompleteChatArtifact = {
    id: artifact.id,
    artifactType: 'story',
    status: 'complete',
    sourceMessageId: artifact.sourceMessageId,
    storyText,
    title: params?.title ?? artifact.title,
    prompt: artifact.prompt,
    voiceId: artifact.voiceId,
    createdAt: artifact.createdAt,
    updatedAt: timestamp,
  };

  assertArtifactInvariants(completed);
  return completed;
}

/**
 * 开始入库流程（complete -> promoting，或 promotion_failed -> promoting 幂等重试）。
 */
export function startPromotion(
  artifact: CompleteChatArtifact | PromotionFailedChatArtifact,
  now?: string
): PromotingChatArtifact {
  if (!isAllowedTransition(artifact.status, 'promoting')) {
    throw new Error(
      `非法状态转移：不能从 ${artifact.status} 转到 promoting`
    );
  }

  const timestamp = now ?? new Date().toISOString();
  const promoting: PromotingChatArtifact = {
    id: artifact.id,
    artifactType: 'story',
    status: 'promoting',
    sourceMessageId: artifact.sourceMessageId,
    storyText: artifact.storyText,
    title: artifact.title,
    prompt: artifact.prompt,
    voiceId: artifact.voiceId,
    createdAt: artifact.createdAt,
    updatedAt: timestamp,
  };

  assertArtifactInvariants(promoting);
  return promoting;
}

/**
 * 幂等重试入库（startPromotion 的语义化别名）。
 */
export function retryPromotion(
  artifact: PromotionFailedChatArtifact,
  now?: string
): PromotingChatArtifact {
  return startPromotion(artifact, now);
}

/**
 * 入库成功（promoting -> ready）。
 * 必须注入合法的正整数 storyWorkId。
 */
export function markPromotionSuccess(
  artifact: PromotingChatArtifact,
  result: {
    readonly storyWorkId: number;
  },
  now?: string
): ReadyChatArtifact {
  if (!isAllowedTransition(artifact.status, 'ready')) {
    throw new Error(
      `非法状态转移：不能从 ${artifact.status} 转到 ready`
    );
  }

  if (
    typeof result.storyWorkId !== 'number' ||
    !Number.isInteger(result.storyWorkId) ||
    result.storyWorkId <= 0
  ) {
    throw new Error(
      `入库成功标记失败：storyWorkId 必须为合法正整数，实际为 ${JSON.stringify(result.storyWorkId)}`
    );
  }

  const timestamp = now ?? new Date().toISOString();
  const ready: ReadyChatArtifact = {
    id: artifact.id,
    artifactType: 'story',
    status: 'ready',
    storyWorkId: result.storyWorkId,
    sourceMessageId: artifact.sourceMessageId,
    storyText: artifact.storyText,
    title: artifact.title,
    prompt: artifact.prompt,
    voiceId: artifact.voiceId,
    createdAt: artifact.createdAt,
    updatedAt: timestamp,
  };

  assertArtifactInvariants(ready);
  return ready;
}

/**
 * 入库失败（promoting -> promotion_failed）。
 * 核心契约：保留原始 storyText 与 sourceMessageId，支持随后幂等重试。
 */
export function markPromotionFailed(
  artifact: PromotingChatArtifact,
  result?: {
    readonly error?: string;
  },
  now?: string
): PromotionFailedChatArtifact {
  if (!isAllowedTransition(artifact.status, 'promotion_failed')) {
    throw new Error(
      `非法状态转移：不能从 ${artifact.status} 转到 promotion_failed`
    );
  }

  const timestamp = now ?? new Date().toISOString();
  const failed: PromotionFailedChatArtifact = {
    id: artifact.id,
    artifactType: 'story',
    status: 'promotion_failed',
    sourceMessageId: artifact.sourceMessageId,
    storyText: artifact.storyText,
    title: artifact.title,
    prompt: artifact.prompt,
    voiceId: artifact.voiceId,
    error: result?.error,
    createdAt: artifact.createdAt,
    updatedAt: timestamp,
  };

  assertArtifactInvariants(failed);
  return failed;
}

/**
 * 生成中断（draft -> interrupted）。
 * 用于流式生成被用户主动终止或发生致命网络错误。
 */
export function interruptArtifact(
  artifact: DraftChatArtifact,
  params?: {
    readonly reason?: string;
  },
  now?: string
): InterruptedChatArtifact {
  if (!isAllowedTransition(artifact.status, 'interrupted')) {
    throw new Error(
      `非法状态转移：不能从 ${artifact.status} 转到 interrupted`
    );
  }

  const timestamp = now ?? new Date().toISOString();
  const interrupted: InterruptedChatArtifact = {
    id: artifact.id,
    artifactType: 'story',
    status: 'interrupted',
    sourceMessageId: artifact.sourceMessageId,
    storyText: artifact.storyText,
    title: artifact.title,
    prompt: artifact.prompt,
    voiceId: artifact.voiceId,
    reason: params?.reason,
    createdAt: artifact.createdAt,
    updatedAt: timestamp,
  };

  assertArtifactInvariants(interrupted);
  return interrupted;
}

// ============================================================================
// Legacy StoryCard 只读兼容辅助函数（B2 冻结语义）
// ============================================================================

/**
 * 解码/规范化历史 Legacy StoryCardPart。
 *
 * 铁律契约（M4-01 B2）：
 * 1. 严格只读兼容：仅返回规范化后的 StoryCardPart，用于历史只读渲染与播放展示；
 * 2. 严禁转为 CompleteChatArtifact：绝不赋予 Legacy 卡片 promotion 状态机能力；
 * 3. 避免会话恢复重入时自动发起 library.create 写入 StoryWork。
 */
export function decodeLegacyStoryCard(
  card: unknown
): StoryCardPart | null {
  if (card === null || typeof card !== 'object') {
    return null;
  }
  const c = card as Record<string, unknown>;
  if (c.type !== 'storyCard') {
    return null;
  }
  if (typeof c.storyText !== 'string' || c.storyText.trim() === '') {
    return null;
  }
  if (typeof c.audioUrl !== 'string') {
    return null;
  }

  return {
    type: 'storyCard',
    storyText: c.storyText,
    audioUrl: c.audioUrl,
  };
}
