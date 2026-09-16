/**
 * StoryCollection 列表分页游标编解码（Keyset / Opaque Cursor）。
 *
 * 集合 id 为 UUID 文本，排序为 createdAt DESC, id DESC（trash 为 deletedAt DESC, id DESC），
 * 因此游标主键为字符串并做字典序比较（UUID 恒小写十六进制，稳定）。
 * 协议与 StoryWork 游标同构：Base64URL + 版本号 + 视图 + 搜索指纹 + 时间戳 + 主键，
 * 严格拒绝伪造、损坏与跨视图/跨搜索串用。
 */

import { LIBRARY_CURSOR_VERSION, LIBRARY_VIEWS } from '@/lib/storyWork/constants';
import { computeQueryFingerprint } from '@/lib/storyWork/cursor';
import type { LibraryView } from '@/lib/storyWork/cursor';

export type CollectionView = LibraryView;

/** 集合游标结构载荷 */
export interface CollectionCursorPayload {
  v: number;
  view: CollectionView;
  q: string;
  t: string;
  id: string;
}

export interface EncodeCollectionCursorOptions {
  v?: number;
  view: CollectionView;
  q?: string;
  query?: string | null;
  t?: string;
  timestamp?: Date | string;
  id: string;
}

/**
 * 编码生成不透明集合分页游标。
 */
export function encodeCollectionCursor(options: EncodeCollectionCursorOptions): string {
  const version = options.v ?? LIBRARY_CURSOR_VERSION;

  if (!LIBRARY_VIEWS.includes(options.view)) {
    throw new Error(`Invalid cursor view: ${options.view}`);
  }
  if (typeof options.id !== 'string' || options.id.length === 0) {
    throw new Error(`Invalid cursor id: ${options.id}`);
  }

  let isoTime = options.t;
  if (!isoTime && options.timestamp) {
    isoTime =
      options.timestamp instanceof Date
        ? options.timestamp.toISOString()
        : new Date(options.timestamp).toISOString();
  }
  if (!isoTime || Number.isNaN(Date.parse(isoTime))) {
    throw new Error(`Invalid cursor timestamp: ${options.t ?? options.timestamp}`);
  }

  const queryFingerprint =
    options.q !== undefined ? options.q : computeQueryFingerprint(options.query);

  const payload: CollectionCursorPayload = {
    v: version,
    view: options.view,
    q: queryFingerprint,
    t: isoTime,
    id: options.id,
  };

  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
}

/**
 * 解码校验集合分页游标；任何非法输入安全返回 null。
 */
export function decodeCollectionCursor(cursor: unknown): CollectionCursorPayload | null {
  if (typeof cursor !== 'string' || !cursor.trim()) return null;

  let jsonStr: string;
  try {
    jsonStr = Buffer.from(cursor, 'base64url').toString('utf-8');
  } catch {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const candidate = raw as Record<string, unknown>;
  if (candidate.v !== LIBRARY_CURSOR_VERSION) return null;
  if (typeof candidate.view !== 'string' || !LIBRARY_VIEWS.includes(candidate.view as CollectionView)) {
    return null;
  }
  if (typeof candidate.q !== 'string') return null;
  if (typeof candidate.t !== 'string' || Number.isNaN(Date.parse(candidate.t))) return null;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;

  return {
    v: candidate.v,
    view: candidate.view as CollectionView,
    q: candidate.q,
    t: candidate.t,
    id: candidate.id,
  };
}

/**
 * 校验游标是否与当前请求的 view/query 匹配。
 */
export function isCollectionCursorMatchingInput(
  cursor: CollectionCursorPayload,
  input: { view?: CollectionView; query?: string | null },
): boolean {
  const expectedView = input.view ?? 'active';
  const expectedFingerprint = computeQueryFingerprint(input.query);
  return cursor.view === expectedView && cursor.q === expectedFingerprint;
}

/**
 * 构建集合 Keyset 分页条件：active/favorites 用 createdAt，trash 用 deletedAt。
 */
export function buildCollectionCursorPredicate(cursor: CollectionCursorPayload) {
  const date = new Date(cursor.t);
  const timeField = cursor.view === 'trash' ? 'deletedAt' : 'createdAt';
  return {
    OR: [
      { [timeField]: { lt: date } },
      { [timeField]: date, id: { lt: cursor.id } },
    ],
  };
}
