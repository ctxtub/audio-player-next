'use client';

/**
 * M6-02 FloatingPlayer compatibility re-export（spec §35）。
 * @deprecated Use MiniNowPlaying from components/NowPlaying. Remove in M9.
 *
 * 正式实现 = components/NowPlaying/MiniNowPlaying；本文件不承载独立实现，
 * 仅保留旧 import surface 可编译：
 * - `import { FloatingPlayer } from '@/components/FloatingPlayer'` → 实际 MiniNowPlaying；
 * - `import { useFloatingPlayer } from '@/components/FloatingPlayer'` → store 兼容别名（@deprecated，M9 删除）。
 * 新代码一律从 '@/components/NowPlaying/*' 导入正式命名。
 */

export { MiniNowPlaying as FloatingPlayer, MiniNowPlaying } from '@/components/NowPlaying/MiniNowPlaying';

/** @deprecated M6-02：旧 UI hook 经组件文件的导入垫片；新代码直引 stores/playbackStore 或 M5 Flow。 */
export { useFloatingPlayer } from '@/stores/playbackStore';
