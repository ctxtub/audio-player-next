/**
 *  Creation Actions Boundary 纯 helper（spec §36/§36.2/§37/§75/）。
 *
 * - Draft「返回创作」（§37）：Draft 本身属于 Chat；Expanded 显示「返回创作」
 *（不是「继续创作」）；点击 = closeExpanded() + router.push('/chat')，
 *   绝不自动发送新 Prompt（无 send 调用、无预填即发、无消息追加）。
 * - Work「继续创作」（§36/§36.2/）：只允许消费
 *   `continueFromStoryWork(workId): Promise<void>` 契约（行为归：
 *   resolve StoryWork → 建上下文 → 回 /chat → 启动流程）；当前仓库该契约
 *   不存在（src grep 空）→ 按 §36.2 隐藏 CTA（fail-closed，绝不伪造
 *   continuation）；一旦  additive contract 落地，直接开启本文件判定
 *   + Actions/Expanded 预留缝合即可，不需改播放架构。
 * - §36.3：不暂停当前播放（本轮 CTA 隐藏，实现时遵循不暂停原则）。
 * - 本文件不读任何 store，不触路由实例，不改播放状态，不拼装任何
 *   continuation Prompt（不消费 storyText，不拼接指令文案）；
 *   调用方（Actions 受控展示 + Expanded 先关后导）执行副作用。
 */

import type { PlaybackSourceRef } from '@/lib/playback/source';
import type { PlaybackSessionStatus } from '@/stores/playbackSessionStore';

/** Draft 返回创作按钮文案（spec §37：精确「返回创作」，不是「继续创作」）。 */
export const BACK_TO_CREATION_LABEL = '返回创作';

/** Draft 返回创作按钮 testid（与查看正文/继续创作独立，行为经父级统一处理）。 */
export const EXPANDED_BACK_TO_CREATION_BUTTON_TESTID = 'expanded-back-to-creation-button';

/** Work 继续创作按钮文案（spec §36： 契约落地后开启；本轮隐藏）。 */
export const CONTINUE_CREATION_LABEL = '继续创作';

/** Work 继续创作按钮 testid（本轮隐藏 fail-closed；additive-ready 预留）。 */
export const EXPANDED_CONTINUE_CREATION_BUTTON_TESTID = 'expanded-continue-creation-button';

/** 创作面路由（Draft 返回创作唯一目标，spec §37）。 */
export const CHAT_ROUTE = '/chat';

/**
 * 纯函数：是否应展示 Draft 返回创作（spec §37）。
 * Draft source + 可展示会话（status 非 idle）即 true；Work/空/idle 一律 false。
 * 注意：不消费 storyText（返回创作与正文有无无关；正文入口仍归 Transcript 口）。
 */
export const shouldShowDraftBackToCreation = (
    source: PlaybackSourceRef | null | undefined,
    status: PlaybackSessionStatus | null | undefined
): boolean => {
    if (source === null || source === undefined) {
        return false;
    }
    if (source.kind !== 'draft') {
        return false;
    }
    if (status === null || status === undefined || status === 'idle') {
        return false;
    }
    return true;
};

/**
 * 纯函数：是否应展示 Work 继续创作（spec §36.2/ fail-closed）。
 *
 * 正式依赖  `continueFromStoryWork(workId): Promise<void>`；当前仓库该契约
 * 未实现（src 无此导出，grep 空），故恒返回 false（隐藏 CTA，而不伪造
 * continuation）。一旦  additive contract 落地，将本函数体替换为
 * Work 合法目标校验 + 契约可用性判定即可，Actions/Expanded 预留分支
 * 无需改播放架构（§36.2 additive-ready）。
 */
export const shouldShowWorkContinueCreation = (
    _source: PlaybackSourceRef | null | undefined,
    _status: PlaybackSessionStatus | null | undefined
): boolean => {
    void _source;
    void _status;
    return false;
};

/**
 * 纯函数：Draft 返回创作目标（spec §37：恒为 /chat）。
 * 可见时返回目标；隐藏时 null（fail-closed，不拼凑）。
 */
export const resolveBackToCreationTarget = (
    source: PlaybackSourceRef | null | undefined,
    status: PlaybackSessionStatus | null | undefined
): string | null => {
    if (!shouldShowDraftBackToCreation(source, status)) {
        return null;
    }
    return CHAT_ROUTE;
};

/** Draft 返回创作展示决策输入。 */
export type DraftBackToCreationDecisionInput = {
    source: PlaybackSourceRef | null | undefined;
    status: PlaybackSessionStatus | null | undefined;
};

/** Draft 返回创作展示决策（纯展示/路由决策，不执行副作用）。 */
export type DraftBackToCreationDecision = {
    /** 是否展示返回创作。 */
    visible: boolean;
    /** 创作面目标（可见时恒为 /chat；隐藏时 null）。 */
    target: string | null;
    /** 是否需要 router.push（可见即 true：先 close 再 push，无同址去重，§37/§44）。 */
    shouldPush: boolean;
};

/**
 * 纯函数：Draft 返回创作总决策（副作用顺序由调用方执行：
 * closeExpanded() 先行 → router.push('/chat')，播放继续，不自动发送）。
 */
export const decideDraftBackToCreation = (
    input: DraftBackToCreationDecisionInput
): DraftBackToCreationDecision => {
    const target = resolveBackToCreationTarget(input.source, input.status);
    if (target === null) {
        return { visible: false, target: null, shouldPush: false };
    }
    return { visible: true, target, shouldPush: true };
};

/** Work 继续创作展示决策输入（additive-ready 预留，与 Draft 同口径）。 */
export type WorkContinueCreationDecisionInput = {
    source: PlaybackSourceRef | null | undefined;
    status: PlaybackSessionStatus | null | undefined;
};

/** Work 继续创作展示决策（本轮恒隐藏，fail-closed）。 */
export type WorkContinueCreationDecision = {
    /** 是否展示继续创作（本轮恒 false）。 */
    visible: boolean;
    /** 延续目标（本轮恒 null：行为归，不在  拼装）。 */
    target: string | null;
    /** 是否需要推进 continuation（本轮恒 false）。 */
    shouldPush: boolean;
};

/**
 * 纯函数：Work 继续创作总决策（本轮恒隐藏，fail-closed）。
 *  契约落地后在此返回真实可见性/目标，调用方经预留 onContinueCreation
 * 委托  契约（ 不拼 Prompt、不暂停播放，§36.3）。
 */
export const decideWorkContinueCreation = (
    _input: WorkContinueCreationDecisionInput
): WorkContinueCreationDecision => {
    void _input;
    return { visible: false, target: null, shouldPush: false };
};
