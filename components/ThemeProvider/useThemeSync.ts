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
   * 初始化时从 configStore 的 themeMode 同步主题。
   * configStore.initialize 已经拉取了 DB settings，此处复用结果避免重复请求。
   */
  useEffect(() => {
    const unsubscribe = useConfigStore.subscribe((state, prevState) => {
      /** 等待 configStore 初始化完成 */
      if (!state.isLoaded) return;
      if (prevState.isLoaded) return; // 仅首次 isLoaded 变为 true 时触发

      const dbThemeMode = state.dbThemeMode;
      if (dbThemeMode && dbThemeMode !== themeMode) {
        setThemeMode(dbThemeMode);
      }
      hasSyncedFromDb.current = true;
      unsubscribe();
    });

    /** 如果 configStore 已经加载完成（组件晚于 initialize 挂载） */
    const currentState = useConfigStore.getState();
    if (currentState.isLoaded) {
      const dbThemeMode = currentState.dbThemeMode;
      if (dbThemeMode && dbThemeMode !== themeMode) {
        setThemeMode(dbThemeMode);
      }
      hasSyncedFromDb.current = true;
      unsubscribe();
    }

    return () => {
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅首次挂载执行
  }, []);

  /** 用户切换主题时写入 DB（跳过初始同步触发的变更，仅登录用户） */
  useEffect(() => {
    if (!hasSyncedFromDb.current) return;
    if (!useConfigStore.getState().isLoggedIn) return;
    saveThemeToDb(themeMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeMode]);
};
