/**
 * Chat Artifact History 编解码 / 恢复边界（M4-06）。
 *
 * 职责：History persistence boundary —— 哪些 Artifact 状态可跨进程持久、
 * reload 后如何安全降级、历史脏数据如何 fail-closed；恢复过程纯读零副作用。
 *
 * 设计原则（冻结）：
 * 1. 纯函数：无视图框架、无状态库、无 network、无作品库直调、无 generation
 *    transport、无播放、不读配置、不产生 promotion 令牌、不 dispatch。
 *    只做 validate → canonicalize → clone。
 * 2. Live 状态机（M4-01 ALLOWED_TRANSITIONS）继续冻结——本模块是独立的
 *    projection / recovery boundary，不改状态机本身，不扩展 live transition。
 * 3. 进程边界恢复规则（冻结）：
 *    - draft → interrupted（原 stream transport 已不存在，不可假装继续生成）
 *    - complete → promotion_failed（正文完整但无确认 StoryWork，需显式 retry reconciliation）
 *    - promoting → promotion_failed（原 async create 结果未知，token/epoch/in-flight slot 已丢失）
 *    - ready → ready（精确保留 storyWorkId）
 *    - promotion_failed → promotion_failed（原样保留）
 *    - interrupted → interrupted（原样保留）
 * 4. Artifact identity 全部保留：id / artifactType / sourceMessageId / storyText /
 *    title / prompt / voiceId / createdAt / updatedAt；稳定态额外保留
 *    ready.storyWorkId / promotion_failed.error / interrupted.reason。
 *    绝不新造 artifact id、绝不新造/猜测 sourceMessageId、绝不从 Settings 补
 *    prompt/voice、绝不改 storyText、绝不去 Library 查询 storyWorkId。
 * 5. Serialization deterministic：不用 Date.now() 改写 updatedAt；同一对象连续
 *    serialize 两次得等价结果；canonicalize 幂等（二次 canonicalize 稳定）。
 */

import type {
  ChatArtifact,
  InterruptedChatArtifact,
  PromotionFailedChatArtifact,
} from '../../types/chatArtifact';
import { isChatArtifact } from '../../types/chatArtifact';
import type {
  ChatMessage,
  MessagePart,
  StoryArtifactPart,
  StoryCardPart,
} from '../../types/chat';
import type { AgentType } from '../../types/agent';
import { validateArtifactInvariants } from './chatArtifactState';

/**
 * History reload 中断原因（稳定内部 reason，deterministic，非公共领域契约）。
 * draft 跨进程后无 stream transport，统一降级为 interrupted 并附此 reason。
 */
export const HISTORY_RELOAD_INTERRUPTED_REASON = 'history_reload_interrupted';

/**
 * History reload promotion 未知错误（deterministic）。
 * complete / promoting 跨进程后 outcome unknown，统一降级为 promotion_failed
 * 并附此 error；已有的 promotion_failed.error 原样保留，不覆盖。
 */
export const HISTORY_RELOAD_PROMOTION_FAILED_ERROR = 'history_reload_promotion_unknown';

/**
 * 服务端历史 DTO 最小形态（仅 History codec 关心的字段；服务端 schema 保持宽松）。
 */
export interface HistoryMessageDTO {
  readonly messageId: string;
  readonly role: string;
  readonly content: string;
  readonly parts?: unknown;
  readonly agentType?: unknown;
  readonly createdAt?: unknown;
}

/**
 * 将已校验合法的 Artifact 投影为可跨进程持久的 durable 形态（纯 clone，不 mutate 输入）。
 * - draft → interrupted（附 HISTORY_RELOAD_INTERRUPTED_REASON）
 * - complete → promotion_failed（附已有 error 或 HISTORY_RELOAD_PROMOTION_FAILED_ERROR）
 * - promoting → promotion_failed（附已有 error 或 HISTORY_RELOAD_PROMOTION_FAILED_ERROR）
 * - ready / promotion_failed / interrupted → 精确 clone
 * @param artifact 已通过领域 invariant 校验的合法 Artifact。
 * @returns 持久形态的 Artifact（新对象，与输入不共享引用）。
 */
export function canonicalizeArtifactForHistory(artifact: ChatArtifact): ChatArtifact {
  const validation = validateArtifactInvariants(artifact);
  if (!validation.valid) {
    throw new Error(`History canonicalize 拒绝非法 Artifact：${validation.errors.join('; ')}`);
  }
  if (!isChatArtifact(artifact)) {
    throw new Error('History canonicalize 拒绝非法 Artifact：isChatArtifact 未通过');
  }
  switch (artifact.status) {
    case 'draft': {
      const interrupted: InterruptedChatArtifact = {
        id: artifact.id,
        artifactType: 'story',
        status: 'interrupted',
        sourceMessageId: artifact.sourceMessageId,
        storyText: artifact.storyText,
        title: artifact.title,
        prompt: artifact.prompt,
        voiceId: artifact.voiceId,
        reason: HISTORY_RELOAD_INTERRUPTED_REASON,
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt,
      };
      return interrupted;
    }
    case 'complete':
    case 'promoting': {
      const rawError = (artifact as unknown as Record<string, unknown>).error;
      const preservedError =
        typeof rawError === 'string' && rawError.trim() !== ''
          ? rawError
          : HISTORY_RELOAD_PROMOTION_FAILED_ERROR;
      const failed: PromotionFailedChatArtifact = {
        id: artifact.id,
        artifactType: 'story',
        status: 'promotion_failed',
        sourceMessageId: artifact.sourceMessageId,
        storyText: artifact.storyText,
        title: artifact.title,
        prompt: artifact.prompt,
        voiceId: artifact.voiceId,
        error: preservedError,
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt,
      };
      return failed;
    }
    case 'ready':
    case 'promotion_failed':
    case 'interrupted': {
      return { ...artifact };
    }
    default: {
      throw new Error(`History canonicalize 拒绝未知 status：${JSON.stringify((artifact as { status?: unknown }).status)}`);
    }
  }
}

/**
 * 对单个 storyArtifact part 做严格校验 + 进程边界恢复（纯函数，失败返回 null）。
 * 校验至少要求：
 * - part.type === 'storyArtifact' 且 artifact 为对象；
 * - owning message 必须是 assistant；
 * - artifact.sourceMessageId === opts.messageId（mismatch 禁止修复，直接丢弃）；
 * - isChatArtifact / validateArtifactInvariants 通过；
 * - ready.storyWorkId 必须为正整数；非 ready 不得携带 storyWorkId；
 * - complete / promoting / promotion_failed / ready 正文满足 domain invariant（非空）。
 * 通过后按 canonicalizeArtifactForHistory 做 transient → durable 降级并 clone。
 * @param rawPart 服务端历史中的原始 part（unknown JSON）。
 * @param opts 归属上下文（messageId + messageRole）。
 * @returns 合法恢复的 StoryArtifactPart；非法一律返回 null（fail-closed，不抛）。
 */
export function rehydrateStoryArtifactPart(
  rawPart: unknown,
  opts: { readonly messageId: string; readonly messageRole: string },
): StoryArtifactPart | null {
  try {
    if (rawPart === null || typeof rawPart !== 'object') {
      return null;
    }
    const part = rawPart as Record<string, unknown>;
    if (part.type !== 'storyArtifact') {
      return null;
    }
    const artifactUnknown = (part as { artifact?: unknown }).artifact;
    if (artifactUnknown === null || typeof artifactUnknown !== 'object') {
      return null;
    }
    if (opts.messageRole !== 'assistant') {
      return null;
    }
    const artifactRec = artifactUnknown as Record<string, unknown>;
    if (typeof artifactRec.sourceMessageId !== 'string' || artifactRec.sourceMessageId !== opts.messageId) {
      return null;
    }
    if (!isChatArtifact(artifactUnknown)) {
      return null;
    }
    const validation = validateArtifactInvariants(artifactUnknown);
    if (!validation.valid) {
      return null;
    }
    const artifact = artifactUnknown as ChatArtifact;
    if (artifact.status === 'ready') {
      const workId = (artifact as unknown as Record<string, unknown>).storyWorkId;
      if (typeof workId !== 'number' || !Number.isInteger(workId) || workId <= 0) {
        return null;
      }
    } else if ((artifact as unknown as Record<string, unknown>).storyWorkId !== undefined) {
      return null;
    }
    if (
      artifact.status === 'complete' ||
      artifact.status === 'promoting' ||
      artifact.status === 'ready' ||
      artifact.status === 'promotion_failed'
    ) {
      if (typeof artifact.storyText !== 'string' || artifact.storyText.trim() === '') {
        return null;
      }
    }
    const recovered = canonicalizeArtifactForHistory(artifact);
    return { type: 'storyArtifact', artifact: recovered };
  } catch {
    return null;
  }
}

/**
 * Save-side 序列化：为落盘准备的 parts clone（纯函数，不 mutate 输入）。
 * - storyCard：clone 并清空 audioUrl（既有行为保持）；
 * - storyArtifact：validate → canonicalize（transient 降级），非法则丢弃该 part；
 * - text / guidance / summary 等：浅 clone 透传；
 * - 非对象 / 无 string type 的 part：丢弃单个 part。
 * 空结果返回 undefined（便于 content fallback），而非空数组。
 * @param parts 内存中的消息 parts。
 * @returns 可持久化的 parts clone；无有效 part 时返回 undefined。
 */
export function serializePartsForHistory(
  parts: MessagePart[] | undefined,
): MessagePart[] | undefined {
  if (parts === undefined || parts === null) {
    return undefined;
  }
  if (!Array.isArray(parts)) {
    return undefined;
  }
  const out: MessagePart[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== 'object') {
      continue;
    }
    const typed = part as MessagePart & Record<string, unknown>;
    if (typed.type === 'storyCard') {
      const card = part as StoryCardPart;
      out.push({ ...card, audioUrl: '' });
      continue;
    }
    if (typed.type === 'storyArtifact') {
      try {
        const artifactUnknown = (part as StoryArtifactPart).artifact;
        if (!isChatArtifact(artifactUnknown)) {
          continue;
        }
        const validation = validateArtifactInvariants(artifactUnknown);
        if (!validation.valid) {
          continue;
        }
        const canonical = canonicalizeArtifactForHistory(artifactUnknown as ChatArtifact);
        out.push({ type: 'storyArtifact', artifact: canonical });
      } catch {
        continue;
      }
      continue;
    }
    if (typeof typed.type !== 'string') {
      continue;
    }
    out.push({ ...(part as unknown as Record<string, unknown>) } as MessagePart);
  }
  if (out.length === 0) {
    return undefined;
  }
  return out;
}

/**
 * Load-side 反序列化 parts（纯函数，失败 fail-closed）。
 * - storyArtifact：经 rehydrateStoryArtifactPart 严格校验 + 降级；非法丢弃该 part；
 * - storyCard / text / guidance / summary：浅 clone 透传（Legacy 不转 StoryArtifact）；
 * - 非数组输入 / 空结果：返回 parts: undefined（走既有 content fallback）。
 * 同时回传首个合法 Artifact 的 storyText，供 message.content 同步（valid Artifact wins）。
 * @param rawParts 服务端历史中的原始 parts（unknown JSON）。
 * @param opts 归属上下文（messageId + messageRole）。
 * @returns 恢复后的 parts 与首个合法 Artifact 正文。
 */
export function rehydratePartsFromHistory(
  rawParts: unknown,
  opts: { readonly messageId: string; readonly messageRole: string },
): { readonly parts: MessagePart[] | undefined; readonly validArtifactText?: string } {
  if (rawParts === undefined || rawParts === null) {
    return { parts: undefined };
  }
  if (!Array.isArray(rawParts)) {
    return { parts: undefined };
  }
  const out: MessagePart[] = [];
  let firstValidText: string | undefined;
  for (const raw of rawParts) {
    if (raw === null || typeof raw !== 'object') {
      continue;
    }
    const rec = raw as Record<string, unknown>;
    if (rec.type === 'storyArtifact') {
      const recovered = rehydrateStoryArtifactPart(raw, opts);
      if (!recovered) {
        continue;
      }
      out.push(recovered);
      if (firstValidText === undefined) {
        firstValidText = recovered.artifact.storyText;
      }
      continue;
    }
    if (typeof rec.type !== 'string') {
      continue;
    }
    out.push({ ...(raw as unknown as Record<string, unknown>) } as MessagePart);
  }
  if (out.length === 0) {
    return { parts: undefined, validArtifactText: firstValidText };
  }
  return { parts: out, validArtifactText: firstValidText };
}

/**
 * Load-side 反序列化单条服务端 DTO 为 ChatMessage（纯函数，永不抛）。
 * - 仅 normalize 服务端历史；调用方必须只对 fetch 结果调用，绝不对
 *   await-window 本地消息调用（见 chatStore.initForUser 接线）。
 * - 合法 Modern StoryArtifact：message.content 统一为 artifact.storyText
 *  （M4-02 withArtifact 在 live path 已保证同步；M4-05 Artifact 自身是 UI source
 *   of truth；此处是 valid Artifact wins，不是 content 修 Artifact）。
 * - 非法 Artifact：保留原 content，丢 part（fail-closed，不 create、不 promotion、
 *   不 crash 整会话、不删整条 message）。
 * - sourceMessageId mismatch：禁止修复，丢 part 保 content。
 * - 无合法 parts 时返回 parts: undefined（走既有 content fallback），而非空数组。
 * - Legacy storyCard / text / guidance / summary：原样透传，不转换、不删。
 * @param dto 服务端返回的单条消息 DTO。
 * @returns 恢复后的 ChatMessage（status 恒为 delivered）。
 */
export function rehydrateMessageFromHistory(dto: HistoryMessageDTO): ChatMessage {
  try {
    const messageId = typeof dto.messageId === 'string' ? dto.messageId : '';
    const role = dto.role as ChatMessage['role'];
    const originalContent = typeof dto.content === 'string' ? dto.content : '';
    const { parts: recoveredParts, validArtifactText } = rehydratePartsFromHistory(dto.parts, {
      messageId,
      messageRole: String(role),
    });
    const content = validArtifactText !== undefined ? validArtifactText : originalContent;
    const createdAt = typeof dto.createdAt === 'string' ? dto.createdAt : undefined;
    const agentTypeRaw = (dto as unknown as Record<string, unknown>).agentType;
    const metadata =
      typeof agentTypeRaw === 'string' && agentTypeRaw.trim() !== ''
        ? { agentType: agentTypeRaw as AgentType }
        : undefined;
    return {
      id: messageId,
      role,
      content,
      parts: recoveredParts,
      status: 'delivered',
      createdAt,
      metadata,
    };
  } catch {
    try {
      const fallback = dto as unknown as Record<string, unknown>;
      const messageId = typeof fallback.messageId === 'string' ? fallback.messageId : '';
      const role = (typeof fallback.role === 'string' ? fallback.role : 'assistant') as ChatMessage['role'];
      const content = typeof fallback.content === 'string' ? fallback.content : '';
      const createdAt = typeof fallback.createdAt === 'string' ? fallback.createdAt : undefined;
      return { id: messageId, role, content, parts: undefined, status: 'delivered', createdAt };
    } catch {
      return { id: '', role: 'assistant', content: '', parts: undefined, status: 'delivered' };
    }
  }
}

/**
 * Load-side 批量反序列化服务端 DTO 数组（纯函数，逐条 fail-closed）。
 * 非法信封（缺 messageId / 缺 role / 非对象）跳过该条，不 crash 整批；
 * 非法 part 只丢该 part，不删整条 message。
 * @param dtos 服务端返回的 DTO 数组。
 * @returns 恢复后的 ChatMessage 数组（顺序与输入一致）。
 */
export function rehydrateServerMessages(dtos: readonly HistoryMessageDTO[]): ChatMessage[] {
  if (!Array.isArray(dtos)) {
    return [];
  }
  const out: ChatMessage[] = [];
  for (const dto of dtos) {
    try {
      if (dto === null || typeof dto !== 'object') {
        continue;
      }
      const rec = dto as Record<string, unknown>;
      if (typeof rec.messageId !== 'string' || rec.messageId.trim() === '') {
        continue;
      }
      if (typeof rec.role !== 'string' || rec.role.trim() === '') {
        continue;
      }
      out.push(rehydrateMessageFromHistory(dto as HistoryMessageDTO));
    } catch {
      continue;
    }
  }
  return out;
}
