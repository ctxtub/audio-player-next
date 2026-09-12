'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { libraryClient } from '@/lib/client/library';
import { libraryKeys } from '@/lib/client/libraryQueries';
import styles from './libraryUndo.module.scss';

export interface UndoSession {
  token: number;
  workId: number;
  workTitle: string;
  movePromise: Promise<unknown>;
}

export interface ActiveUndoState {
  token: number;
  workId: number;
  workTitle: string;
  isUndoing: boolean;
}

export interface ShowUndoParams {
  workId: number;
  workTitle: string;
  movePromise: Promise<unknown>;
}

export interface LibraryUndoContextValue {
  activeUndo: ActiveUndoState | null;
  showUndo: (params: ShowUndoParams) => number;
  dismissUndo: (token?: number) => void;
  triggerUndo: () => Promise<void>;
}

const defaultUndoContext: LibraryUndoContextValue = {
  activeUndo: null,
  showUndo: () => 0,
  dismissUndo: () => {},
  triggerUndo: async () => {},
};

export const LibraryUndoContext =
  createContext<LibraryUndoContextValue>(defaultUndoContext);

export function useLibraryUndo(): LibraryUndoContextValue {
  return useContext(LibraryUndoContext) ?? defaultUndoContext;
}

export interface LibraryUndoProviderProps {
  children: React.ReactNode;
}

/**
 * 故事库全局撤销能力提供者（M3-05）
 *
 * 挂载于 app/(main)/library/layout.tsx，为 /library 与 /library/[id] 提供共享的瞬时撤销生命周期。
 *
 * 核心并发与竞态保证：
 * 1. move pending 时点 Undo：严格串行 await movePromise → then restore(id)；
 * 2. move 失败：不展示 Undo，立即回滚；
 * 3. 基于递增 token 隔离：旧 move promise 的 resolve/reject 绝不污染随后触发的新 Undo 会话；
 * 4. 纯 Transient State（Context + useState），严格禁止引入持久化全局 store。
 */
export const LibraryUndoProvider: React.FC<LibraryUndoProviderProps> = ({
  children,
}) => {
  const queryClient = useContext(QueryClientContext) ?? null;

  const [activeUndo, setActiveUndo] = useState<ActiveUndoState | null>(null);
  const currentSessionRef = useRef<UndoSession | null>(null);
  const sessionCounterRef = useRef<number>(0);
  const autoDismissTimerRef = useRef<NodeJS.Timeout | null>(null);

  const dismissUndo = useCallback((token?: number) => {
    if (token === undefined || currentSessionRef.current?.token === token) {
      if (autoDismissTimerRef.current) {
        clearTimeout(autoDismissTimerRef.current);
        autoDismissTimerRef.current = null;
      }
      currentSessionRef.current = null;
      setActiveUndo(null);
    }
  }, []);

  const showUndo = useCallback(
    (params: ShowUndoParams): number => {
      if (autoDismissTimerRef.current) {
        clearTimeout(autoDismissTimerRef.current);
        autoDismissTimerRef.current = null;
      }

      const token = ++sessionCounterRef.current;
      const session: UndoSession = {
        token,
        workId: params.workId,
        workTitle: params.workTitle,
        movePromise: params.movePromise,
      };

      currentSessionRef.current = session;
      setActiveUndo({
        token,
        workId: params.workId,
        workTitle: params.workTitle,
        isUndoing: false,
      });

      // 监听在途 movePromise 的结果
      params.movePromise
        .then(() => {
          // 仅当当前会话仍然是该 token 时，才启动自动消失计时器
          // 若在此期间用户已发起新的 move 操作（token 已递增），旧 promise 的完成绝不触碰新 session
          if (currentSessionRef.current?.token === token) {
            autoDismissTimerRef.current = setTimeout(() => {
              if (currentSessionRef.current?.token === token) {
                currentSessionRef.current = null;
                setActiveUndo(null);
              }
            }, 6000);
          }
        })
        .catch(() => {
          // move 失败：若当前会话仍为该 token，立即关闭 Undo
          if (currentSessionRef.current?.token === token) {
            currentSessionRef.current = null;
            setActiveUndo(null);
          }
        });

      return token;
    },
    []
  );

  const triggerUndo = useCallback(async () => {
    const session = currentSessionRef.current;
    if (!session) return;

    setActiveUndo((prev) => (prev ? { ...prev, isUndoing: true } : null));

    try {
      // 1. 核心串行保证：必须首先等待在途 movePromise 完全 resolve！
      // 严禁在 movePromise 未决前直接触发 restore，否则会导致服务端状态冲突 (409 CONFLICT)
      await session.movePromise;

      // 2. 只有在 move 真正成功后，才调用 restore(id)
      await libraryClient.restore({ id: session.workId });

      // 3. 成功后失效受影响列表缓存（active, favorites, trash），严格禁止本地拼接
      if (queryClient) {
        await queryClient.invalidateQueries({ queryKey: libraryKeys.lists() });
        await queryClient.invalidateQueries({
          queryKey: libraryKeys.detail(session.workId),
        });
      }
    } catch (err) {
      console.error('Undo execution failed:', err);
    } finally {
      // 无论成功还是失败，只要当前仍是该 session，关闭 Undo 提示
      if (currentSessionRef.current?.token === session.token) {
        if (autoDismissTimerRef.current) {
          clearTimeout(autoDismissTimerRef.current);
          autoDismissTimerRef.current = null;
        }
        currentSessionRef.current = null;
        setActiveUndo(null);
      }
    }
  }, [queryClient]);

  return (
    <LibraryUndoContext.Provider
      value={{
        activeUndo,
        showUndo,
        dismissUndo,
        triggerUndo,
      }}
    >
      {children}

      {/* 撤销提示悬浮条 */}
      {activeUndo ? (
        <div
          role="status"
          aria-live="polite"
          className={styles.undoToast}
          data-testid="library-undo-toast"
          data-work-id={activeUndo.workId}
        >
          <span
            className={styles.undoMessage}
            data-testid="library-undo-message"
          >
            已将《{activeUndo.workTitle}》移入回收站
          </span>
          <button
            type="button"
            className={styles.undoButton}
            onClick={() => triggerUndo()}
            disabled={activeUndo.isUndoing}
            data-testid="library-undo-btn"
            aria-label={`撤销移入回收站《${activeUndo.workTitle}》`}
          >
            {activeUndo.isUndoing ? '正在恢复...' : '撤销'}
          </button>
          <button
            type="button"
            className={styles.undoDismissBtn}
            onClick={() => dismissUndo(activeUndo.token)}
            data-testid="library-undo-dismiss-btn"
            aria-label="关闭提示"
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
    </LibraryUndoContext.Provider>
  );
};

export default LibraryUndoProvider;
