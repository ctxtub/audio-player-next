'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import {
  canonicalizeQuery,
  parseLibraryView,
  serializeLibraryUrl,
  SEARCH_DEBOUNCE_MS,
} from '@/lib/client/libraryFilters';
import type { LibraryView } from '@/lib/client/library';

export {
  canonicalizeQuery,
  parseLibraryView,
  serializeLibraryUrl,
  parseLibraryUrl,
  SEARCH_DEBOUNCE_MS,
  VALID_LIBRARY_VIEWS,
  DEFAULT_LIBRARY_VIEW,
  type LibraryUrlFilters,
  type RouterLike,
} from '@/lib/client/libraryFilters';

export interface UseLibraryFiltersOptions {
  basePath?: string;
}

export interface UseLibraryFiltersResult {
  view: LibraryView;
  q?: string;
  draftQ: string;
  isComposing: boolean;
  setDraftQ: (nextText: string) => void;
  setView: (nextView: LibraryView) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (e?: React.CompositionEvent<HTMLInputElement>) => void;
  clearSearch: () => void;
}

/**
 * 故事库 URL 视图与搜索状态管理 Hook (M3-03)
 *
 * 核心契约：
 * 1. 严格单向数据源：input draft -> 300ms debounce -> URL q (canonical) -> queryKey 变更；
 * 2. 严禁直接发起 query 再异步写 URL；
 * 3. view 变更使用 router.push（产生历史点）；
 * 4. 搜索防抖提交使用 router.replace（避免每次敲字污染浏览器前进后退历史）；
 * 5. 切 view 默认保留当前有效搜索词；
 * 6. IME 拼音输入期间完全挂起防抖，组合结束后以最终结果重新倒计时 300ms；
 * 7. 浏览器 Back/Forward 外部变更时，input draft 自动同步，且立即取消旧 timer，不产生任何额外路由操作。
 */
export function useLibraryFilters(
  options: UseLibraryFiltersOptions = {}
): UseLibraryFiltersResult {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname() || '/library';
  const basePath = options.basePath ?? pathname;
  // 契约严格冻结为 300ms，不允许外部 override
  const debounceMs = SEARCH_DEBOUNCE_MS;

  // 1. 从权威 URL 响应式读取当前 view 与 canonical q
  const rawView = searchParams?.get('view') ?? null;
  const rawQ = searchParams?.get('q') ?? null;

  const view = parseLibraryView(rawView);
  const q = canonicalizeQuery(rawQ);

  // 2. 本地草稿与 IME 组合状态
  const [draftQ, setDraftQState] = useState<string>(q ?? '');
  const [isComposing, setIsComposing] = useState<boolean>(false);

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isComposingRef = useRef<boolean>(false);
  const draftQRef = useRef<string>(draftQ);
  draftQRef.current = draftQ;

  const clearTimer = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  // 组件卸载时安全清理定时器
  useEffect(() => {
    return () => {
      clearTimer();
    };
  }, [clearTimer]);

  // 3. 响应浏览器前进/后退（URL 权威变更）：外部 URL 成为新权威状态，清除旧的 pending search timer 并同步草稿
  useEffect(() => {
    // 外部 URL 已成为新的 authoritative state：所有基于旧 URL 建立的 pending search commit 全部失效
    clearTimer();
    if (!isComposingRef.current) {
      const nextDraft = q ?? '';
      setDraftQState(nextDraft);
      draftQRef.current = nextDraft;
    }
  }, [q, view, clearTimer]);

  // 4. 将规整后的 canonical q 提交至 URL（使用 router.replace）
  const commitCanonicalQuery = useCallback(
    (textToCommit: string) => {
      const canonical = canonicalizeQuery(textToCommit);
      if (canonical !== q) {
        const nextUrl = serializeLibraryUrl({ view, q: canonical }, basePath);
        router.replace(nextUrl);
      }
    },
    [basePath, q, router, view]
  );

  // 5. 输入框草稿变更触发防抖
  const setDraftQ = useCallback(
    (nextText: string) => {
      setDraftQState(nextText);
      draftQRef.current = nextText;

      // 若正处于 IME 拼音输入状态，挂起防抖定时器，零调用
      if (isComposingRef.current) {
        clearTimer();
        return;
      }

      clearTimer();
      debounceTimerRef.current = setTimeout(() => {
        commitCanonicalQuery(draftQRef.current);
      }, debounceMs);
    },
    [clearTimer, commitCanonicalQuery, debounceMs]
  );

  // 6. IME 输入开始
  const onCompositionStart = useCallback(() => {
    isComposingRef.current = true;
    setIsComposing(true);
    clearTimer();
  }, [clearTimer]);

  // 7. IME 输入结束
  const onCompositionEnd = useCallback(
    (e?: React.CompositionEvent<HTMLInputElement>) => {
      isComposingRef.current = false;
      setIsComposing(false);
      clearTimer();

      const finalVal = e?.currentTarget?.value ?? draftQRef.current;
      setDraftQState(finalVal);
      draftQRef.current = finalVal;

      // IME 组合结束后，从此时起重新开始完整的防抖计时
      debounceTimerRef.current = setTimeout(() => {
        commitCanonicalQuery(draftQRef.current);
      }, debounceMs);
    },
    [clearTimer, commitCanonicalQuery, debounceMs]
  );

  // 8. 切换视图（使用 router.push，保留当前搜索词）
  const setView = useCallback(
    (nextView: LibraryView) => {
      clearTimer();
      const validNextView = parseLibraryView(nextView);
      const nextUrl = serializeLibraryUrl({ view: validNextView, q }, basePath);
      router.push(nextUrl);
    },
    [basePath, clearTimer, q, router]
  );

  // 9. 清空搜索
  const clearSearch = useCallback(() => {
    clearTimer();
    setDraftQState('');
    draftQRef.current = '';
    commitCanonicalQuery('');
  }, [clearTimer, commitCanonicalQuery]);

  return {
    view,
    q,
    draftQ,
    isComposing,
    setDraftQ,
    setView,
    onCompositionStart,
    onCompositionEnd,
    clearSearch,
  };
}
