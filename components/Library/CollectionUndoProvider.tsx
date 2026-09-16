'use client';

/**
 * Collection 全局撤销提供者（）。
 *
 * 与 LibraryUndoProvider（Work 级）同构的集合级瞬时撤销生命周期：
 * 1. move pending 时点 Undo：串行 await movePromise → then restoreCollection(id)；
 * 2. move 失败：不展示 Undo，立即回滚；
 * 3. 递增 token 隔离：旧 move promise 绝不污染新会话；
 * 4. 纯 Transient State（Context + useState），无持久化全局 store。
 *
 * 成功后失效全部集合列表缓存与对应详情（禁止本地拼接跨视图）。
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { restoreCollection } from '@/lib/client/collection';
import { collectionKeys } from '@/lib/client/collectionQueries';
import styles from './libraryUndo.module.scss';

export interface CollectionUndoSession {
  token: number;
  collectionId: string;
  collectionTitle: string;
  movePromise: Promise<unknown>;
}

export interface ActiveCollectionUndoState {
  token: number;
  collectionId: string;
  collectionTitle: string;
  isUndoing: boolean;
}

export interface ShowCollectionUndoParams {
  collectionId: string;
  collectionTitle: string;
  movePromise: Promise<unknown>;
}

export interface CollectionUndoContextValue {
  activeUndo: ActiveCollectionUndoState | null;
  showUndo: (params: ShowCollectionUndoParams) => number;
  dismissUndo: (token: number) => void;
  triggerUndo: () => Promise<void>;
}

const defaultCollectionUndoContext: CollectionUndoContextValue = {
  activeUndo: null,
  showUndo: () => 0,
  dismissUndo: () => {},
  triggerUndo: async () => {},
};

export const CollectionUndoContext =
  createContext<CollectionUndoContextValue>(defaultCollectionUndoContext);

export function useCollectionUndo(): CollectionUndoContextValue {
  return useContext(CollectionUndoContext) ?? defaultCollectionUndoContext;
}

export interface CollectionUndoProviderProps {
  children: React.ReactNode;
}

export const CollectionUndoProvider: React.FC<CollectionUndoProviderProps> = ({
  children,
}) => {
  const queryClient = useContext(QueryClientContext) ?? null;

  const [activeUndo, setActiveUndo] = useState<ActiveCollectionUndoState | null>(null);
  const currentSessionRef = useRef<CollectionUndoSession | null>(null);
  const sessionCounterRef = useRef<number>(0);
  const autoDismissTimerRef = useRef<NodeJS.Timeout | null>(null);

  const dismissUndo = useCallback((token: number) => {
    if (typeof token === 'number' && currentSessionRef.current?.token === token) {
      if (autoDismissTimerRef.current) {
        clearTimeout(autoDismissTimerRef.current);
        autoDismissTimerRef.current = null;
      }
      currentSessionRef.current = null;
      setActiveUndo(null);
    }
  }, []);

  const showUndo = useCallback((params: ShowCollectionUndoParams): number => {
    if (autoDismissTimerRef.current) {
      clearTimeout(autoDismissTimerRef.current);
      autoDismissTimerRef.current = null;
    }

    const token = ++sessionCounterRef.current;
    const session: CollectionUndoSession = {
      token,
      collectionId: params.collectionId,
      collectionTitle: params.collectionTitle,
      movePromise: params.movePromise,
    };

    currentSessionRef.current = session;
    setActiveUndo({
      token,
      collectionId: params.collectionId,
      collectionTitle: params.collectionTitle,
      isUndoing: false,
    });

    params.movePromise
      .then(() => {
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
        if (currentSessionRef.current?.token === token) {
          currentSessionRef.current = null;
          setActiveUndo(null);
        }
      });

    return token;
  }, []);

  const triggerUndo = useCallback(async () => {
    const session = currentSessionRef.current;
    if (!session) return;

    setActiveUndo((prev) => (prev ? { ...prev, isUndoing: true } : null));

    try {
      await session.movePromise;
      await restoreCollection(session.collectionId);
      if (queryClient) {
        await queryClient.invalidateQueries({ queryKey: collectionKeys.lists() });
        await queryClient.invalidateQueries({
          queryKey: collectionKeys.detail(session.collectionId),
        });
      }
    } catch (err) {
      console.error('Collection undo execution failed:', err);
    } finally {
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
    <CollectionUndoContext.Provider
      value={{ activeUndo, showUndo, dismissUndo, triggerUndo }}
    >
      {children}
      {activeUndo ? (
        <div
          role="status"
          aria-live="polite"
          className={styles.undoToast}
          data-testid="library-undo-toast"
          data-collection-id={activeUndo.collectionId}
        >
          <span className={styles.undoMessage} data-testid="library-undo-message">
            已将作品集《{activeUndo.collectionTitle}》移入回收站
          </span>
          <button
            type="button"
            className={styles.undoButton}
            onClick={() => triggerUndo()}
            disabled={activeUndo.isUndoing}
            data-testid="library-undo-btn"
            aria-label={`撤销移入回收站《${activeUndo.collectionTitle}》`}
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
    </CollectionUndoContext.Provider>
  );
};

export default CollectionUndoProvider;
