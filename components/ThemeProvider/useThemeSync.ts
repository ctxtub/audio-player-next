'use client';

import { useEffect, useRef } from 'react';
import { useDebounceFn } from 'ahooks';
import type { ThemeMode } from '@/types/theme';
import { trpc } from '@/lib/trpc/client';
import { THEME_MODE_STORAGE_KEY } from './themeConfig';

/**
 * 主题同步 Hook：将主题模式持久化到数据库，并在登录后从 DB 恢复。
 * localStorage 仍作为缓存保证首屏无闪烁。
 * @param themeMode 当前主题模式
 * @param setThemeMode 设置主题模式的回调
 */
export const useThemeSync = (
  themeMode: ThemeMode,
  setThemeMode: (mode: ThemeMode) => void
) => {
  /** 标记是否已从 DB 完成初始同步，避免将 DB 值回写 */
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

  /** 初始化时从 DB 拉取主题设置并同步 */
  useEffect(() => {
    let cancelled = false;

    trpc.settings.get
      .query()
      .then(settings => {
        if (cancelled || !settings) return;

        const dbTheme = settings.themeMode;
        if (dbTheme && dbTheme !== themeMode) {
          setThemeMode(dbTheme);
          /** 同步更新 localStorage 缓存 */
          try {
            window.localStorage.setItem(THEME_MODE_STORAGE_KEY, dbTheme);
          } catch {
            // ignore
          }
        }
        hasSyncedFromDb.current = true;
      })
      .catch(() => {
        /** 未登录或网络失败，静默使用本地缓存 */
        hasSyncedFromDb.current = true;
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅首次挂载执行
  }, []);

  /** 用户切换主题时写入 DB（跳过 DB 初始同步触发的变更） */
  useEffect(() => {
    if (!hasSyncedFromDb.current) return;
    saveThemeToDb(themeMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeMode]);
};
