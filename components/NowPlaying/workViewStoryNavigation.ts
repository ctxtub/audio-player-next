/**
 * M7-04-01 Work 查看正文导航副作用纯 helper（spec §33-§34 / §44）。
 *
 * - 目标仅由 PlaybackSourceRef.workId 直接派生（`/library/${workId}`）；
 * - Draft / 空 source 一律返回 null（绝不拼凑 Library 目标）；
 * - 同 Detail 去重由调用方经 isSameLibraryDetail 判定（只 close，不重复 push）；
 * - 本文件不读任何 store，不触路由实例，不改播放状态（调用方先 closeExpanded
 *   再按需 router.push，播放继续）。
 */

import { isValidWorkId, type PlaybackSourceRef } from '@/lib/playback/source';

/** Expanded 内容区查看正文按钮文案（spec §34）。 */
export const VIEW_STORY_LABEL = '查看正文';

/** Expanded 内容动作区 testid（Actions 容器）。 */
export const EXPANDED_ACTIONS_TESTID = 'expanded-actions';

/** 查看正文按钮 testid。 */
export const EXPANDED_VIEW_STORY_BUTTON_TESTID = 'expanded-view-story-button';

/** Library Detail 路由基座（Work 正文归属面，spec §33）。 */
export const LIBRARY_ROUTE_BASE = '/library';

/**
 * 纯函数：由 Work source 直接派生 Library 目标。
 * 仅消费 source.workId（positive int 校验）；其余一律 null。
 */
export const resolveWorkLibraryTarget = (
    source: PlaybackSourceRef | null | undefined
): string | null => {
    if (source === null || source === undefined) {
        return null;
    }
    if (source.kind !== 'work') {
        return null;
    }
    const workId = (source as { kind: 'work'; workId: number }).workId;
    if (!isValidWorkId(workId)) {
        return null;
    }
    return `${LIBRARY_ROUTE_BASE}/${workId}`;
};

/**
 * 纯函数：是否应展示查看正文（Work 合法目标存在即展示）。
 */
export const shouldShowWorkViewStory = (
    source: PlaybackSourceRef | null | undefined
): boolean => resolveWorkLibraryTarget(source) !== null;

/**
 * 纯函数：Library 路径归一（去尾斜杠；非字符串/空回退 null）。
 */
export const normalizeLibraryPathname = (pathname: string | null | undefined): string | null => {
    if (typeof pathname !== 'string') {
        return null;
    }
    const trimmed = pathname.trim();
    if (trimmed.length === 0) {
        return null;
    }
    if (trimmed === '/') {
        return trimmed;
    }
    return trimmed.replace(/\/+$/, '');
};

/**
 * 纯函数：当前位置是否已是同一 Library Detail（是则只 close，不重复 push，§34.1）。
 */
export const isSameLibraryDetail = (
    pathname: string | null | undefined,
    target: string | null | undefined
): boolean => {
    if (typeof target !== 'string' || target.length === 0) {
        return false;
    }
    const current = normalizeLibraryPathname(pathname);
    const normalizedTarget = normalizeLibraryPathname(target);
    if (current === null || normalizedTarget === null) {
        return false;
    }
    return current === normalizedTarget;
};

/** 查看正文导航决策输入。 */
export type WorkViewStoryNavigationInput = {
    source: PlaybackSourceRef | null | undefined;
    pathname: string | null | undefined;
};

/** 查看正文导航决策结果（纯展示/路由决策，不执行副作用）。 */
export type WorkViewStoryNavigationDecision = {
    /** 是否展示查看正文（Work 合法目标存在）。 */
    visible: boolean;
    /** Library 目标（Work 直接派生；Draft/空为 null）。 */
    target: string | null;
    /** 是否需要 router.push（已在同一 Detail 则 false，只 close）。 */
    shouldPush: boolean;
};

/**
 * 纯函数：查看正文导航总决策（副作用顺序由调用方执行：
 * closeExpanded() 先行，需要时再 router.push(target)，播放继续）。
 */
export const decideWorkViewStoryNavigation = (
    input: WorkViewStoryNavigationInput
): WorkViewStoryNavigationDecision => {
    const target = resolveWorkLibraryTarget(input.source);
    if (target === null) {
        return { visible: false, target: null, shouldPush: false };
    }
    return {
        visible: true,
        target,
        shouldPush: !isSameLibraryDetail(input.pathname, target),
    };
};
