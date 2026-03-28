'use client';

import { useEffect, useRef } from 'react';
import { useDebounceFn } from 'ahooks';
import type { ThemeMode } from '@/types/theme';
import { trpc } from '@/lib/trpc/client';
import { useConfigStore } from '@/stores/configStore';

/**
 * 主题同步 Hook：将主题模式持久化到数据库，并在初始化完成后从 configStore 恢复。
 * localStorage 仍作为缓存保证首屏无闪烁。
 * @param themeMode 当前主题模式
 * @param setThemeMode 设置主题模式的回调
 */
export const useThemeSync = (
  themeMode: ThemeMode,
  setThemeMode: (mode: ThemeMode) => void
) => {
  /** 标记是否已完成初始同步，避免将恢复的值回写 DB */
  const hasSyncedFromDb = useRef(false);
  /** 记录上一次同步的 dbThemeMode，避免重复同步 */
  const lastSyncedDbTheme = useRef<string | null>(null);

  /** 防抖保存主题到数据库 */
  const { run: saveThemeToDb } = useDebounceFn(
    (mode: ThemeMode) => {
      trpc.settings.save.mutate({ themeMode: mode }).catch((err: unknown) => {
        console.warn('[ThemeSync] save failed', err);
      });
    },
    { wait: 500 }
  );

  /**
   * 从 configStore.dbThemeMode 同步主题。
   * 响应两种场景：1) 应用初始化完成 2) 用户登录后拉取到 DB 主题
   */
  useEffect(() => {
    const syncTheme = (dbThemeMode: ThemeMode | null) => {
      if (!dbThemeMode) return;
      if (dbThemeMode === lastSyncedDbTheme.current) return;
      lastSyncedDbTheme.current = dbThemeMode;
      if (dbThemeMode !== themeMode) {
        setThemeMode(dbThemeMode);
      }
      hasSyncedFromDb.current = true;
    };

    /** 订阅 configStore 的 dbThemeMode 变化 */
    const unsubscribe = useConfigStore.subscribe((state, prevState) => {
      if (!state.isLoaded) return;
      if (state.dbThemeMode !== prevState.dbThemeMode || (!prevState.isLoaded && state.isLoaded)) {
        syncTheme(state.dbThemeMode);
      }
    });

    /** 如果 configStore 已经加载完成（组件晚于 initialize 挂载） */
    const currentState = useConfigStore.getState();
    if (currentState.isLoaded) {
      syncTheme(currentState.dbThemeMode);
    }

    /** 匿名用户没有 DB 主题，仍需标记同步完成以放行后续写入 */
    if (currentState.isLoaded && !currentState.dbThemeMode) {
      hasSyncedFromDb.current = true;
    }

    return () => {
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅首次挂载注册订阅
  }, []);

  /** 用户切换主题时写入 DB（跳过初始同步触发的变更，仅登录用户） */
  useEffect(() => {
    if (!hasSyncedFromDb.current) return;
    if (!useConfigStore.getState().isLoggedIn) return;
    saveThemeToDb(themeMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeMode]);
};
