/**
 * StoryWork 列表分页游标编解码（Keyset / Opaque Cursor）
 *
 * 采用不透明 Base64URL 编码，内置协议版本号、视图类型、搜索指纹、排序时间戳与主键 ID。
 * 支持稳定双向 round-trip，严格防御非法伪造、格式损坏与跨视图/跨搜索串用。
 */

import {
  LIBRARY_CURSOR_VERSION,
  LIBRARY_VIEWS,
} from './constants';

export type LibraryView = (typeof LIBRARY_VIEWS)[number];

/** 游标结构载荷 */
export interface LibraryCursorPayload {
  /** 游标协议版本 */
  v: number;
  /** 所属列表视图 */
  view: LibraryView;
  /** 查询词指纹 */
  q: string;
  /** 排序游标时间戳（ISO 字符串） */
  t: string;
  /** Keyset 主键 ID */
  id: number;
}

/** 编码游标入参 */
export interface EncodeLibraryCursorOptions {
  v?: number;
  view: LibraryView;
  q?: string;
  query?: string | null;
  t?: string;
  timestamp?: Date | string;
  id: number;
}

/**
 * 搜索关键词单点规整：去首尾空格。
 */
export function normalizeQuery(query?: string | null): string {
  if (!query) return '';
  return query.trim();
}

/**
 * 计算搜索关键词指纹。
 */
export function computeQueryFingerprint(query?: string | null): string {
  return normalizeQuery(query);
}

/**
 * 编码生成不透明分页游标。
 */
export function encodeLibraryCursor(options: EncodeLibraryCursorOptions): string {
  const version = options.v ?? LIBRARY_CURSOR_VERSION;

  if (!LIBRARY_VIEWS.includes(options.view)) {
    throw new Error(`Invalid cursor view: ${options.view}`);
  }

  if (typeof options.id !== 'number' || !Number.isInteger(options.id) || options.id <= 0) {
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

  const payload: LibraryCursorPayload = {
    v: version,
    view: options.view,
    q: queryFingerprint,
    t: isoTime,
    id: options.id,
  };

  const jsonStr = JSON.stringify(payload);
  return Buffer.from(jsonStr, 'utf-8').toString('base64url');
}

/**
 * 解码校验分页游标。
 * 若格式损坏、版本不符、视图未知、时间戳非法或 ID 异常，一律安全返回 null。
 */
export function decodeLibraryCursor(cursor: unknown): LibraryCursorPayload | null {
  if (typeof cursor !== 'string' || !cursor.trim()) {
    return null;
  }

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

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const candidate = raw as Record<string, unknown>;

  // 1. 协议版本号检查
  if (candidate.v !== LIBRARY_CURSOR_VERSION) {
    return null;
  }

  // 2. 视图枚举校验
  if (
    typeof candidate.view !== 'string' ||
    !LIBRARY_VIEWS.includes(candidate.view as LibraryView)
  ) {
    return null;
  }

  // 3. 查询词指纹校验
  if (typeof candidate.q !== 'string') {
    return null;
  }

  // 4. 时间戳合法性校验
  if (
    typeof candidate.t !== 'string' ||
    Number.isNaN(Date.parse(candidate.t))
  ) {
    return null;
  }

  // 5. 记录主键正整数校验
  if (
    typeof candidate.id !== 'number' ||
    !Number.isInteger(candidate.id) ||
    candidate.id <= 0
  ) {
    return null;
  }

  return {
    v: candidate.v,
    view: candidate.view as LibraryView,
    q: candidate.q,
    t: candidate.t,
    id: candidate.id,
  };
}

/**
 * 校验游标是否与当前请求的 view 与 query 匹配。
 * 防御客户端跨视图或跨搜索词误传游标。
 */
export function isCursorMatchingInput(
  cursor: LibraryCursorPayload,
  input: { view?: LibraryView; query?: string | null }
): boolean {
  const expectedView = input.view ?? 'active';
  const expectedFingerprint = computeQueryFingerprint(input.query);
  return cursor.view === expectedView && cursor.q === expectedFingerprint;
}

/**
 * 构建游标分页的 Keyset 条件断言：
 * active / favorites: ORDER BY createdAt DESC, id DESC
 * trash: ORDER BY deletedAt DESC, id DESC
 */
export function buildCursorPredicate(cursor: LibraryCursorPayload) {
  const date = new Date(cursor.t);
  const timeField = cursor.view === 'trash' ? 'deletedAt' : 'createdAt';
  return {
    OR: [
      { [timeField]: { lt: date } },
      {
        [timeField]: date,
        id: { lt: cursor.id },
      },
    ],
  };
}
