/**
 * M8 Canonical Audio Storage 抽象契约（spec §2.4/§4；M8-02）。
 *
 * Backend-neutral：业务层只依赖本文件导出的 `AudioAssetStorage` 接口，
 * 绝不直接依赖 S3 SDK / filesystem path / bucket URL（由单测静态守卫锁定）。
 * Local 与 S3 语义在契约层一致（同一接口、同一 route 行为；差异只在传输：
 * Local 返回 bytes 流，S3 返回短时签名 URL 的 307 redirect）。
 */

/** 写入音频对象的输入（key 为 opaque storageKey，不编码任何业务身份，spec §6.2/§33） */
export type PutAudioObjectInput = {
  /** Opaque 对象 key（形如 story-audio/<uuid>.mp3） */
  key: string;
  /** 音频字节（MP3） */
  bytes: Uint8Array;
  /** Content-Type（canonical 为 audio/mpeg） */
  contentType: string;
};

/** 对象元数据（不含 bytes 本体） */
export type AudioObjectMetadata = {
  /** 字节长度 */
  size: number;
  /** Content-Type */
  contentType: string;
};

/** 字节区间（闭区间 [start, end]，供 206 Partial Content 映射） */
export type AudioByteRange = {
  start: number;
  end: number;
};

/**
 * 存储读取结果（backend 差异只在此联合体的分支选择）：
 * - `bytes`：Local 后端直接返回字节（full 或单区间 slice），route 映射为 200/206；
 * - `redirect`：S3 后端返回短时签名 GET URL，route 映射为 307（App 不代理 S3 bytes，spec §19.3）。
 */
export type AudioStorageReadResult =
  | {
      kind: 'bytes';
      /** 本次返回的字节（full 时为全部，range 命中时为闭区间 slice） */
      bytes: Uint8Array;
      contentType: string;
      /** 对象总长度（Content-Range 分母；416 时亦由此派生 `bytes star-slash-total`） */
      totalSize: number;
      /** 命中的区间；null 表示 full（route 返回 200） */
      range: AudioByteRange | null;
    }
  | {
      kind: 'redirect';
      /** 短时签名 GET URL（private bucket，spec §3） */
      url: string;
    };

/**
 * Canonical 音频资产存储接口（spec §4；两个 backend 共用同一业务接口）。
 *
 * 不是 local+S3 双写、不做 Hot Cache（spec §2.3/§2.4）：
 * 同一代码按配置选择一个 canonical backend。
 */
export interface AudioAssetStorage {
  /** 写入（同 key 覆盖写；支撑“DB ready 更新失败 → retry overwrite 同一 object”，spec §18.1） */
  put(input: PutAudioObjectInput): Promise<void>;

  /** 对象是否存在 */
  exists(key: string): Promise<boolean>;

  /** 删除（幂等：不存在亦成功返回，供 tombstone 清理重试） */
  delete(key: string): Promise<void>;

  /** 读取元数据；不存在返回 null */
  getMetadata(key: string): Promise<AudioObjectMetadata | null>;

  /**
   * 解析一次读取。
   * @param key opaque storageKey
   * @param rangeHeader 原始 HTTP Range 头（可缺省；S3 后端忽略，由对象存储原生处理 Range）
   * @throws {AudioObjectNotFoundError} 对象不存在
   * @throws {StorageRangeNotSatisfiableError} Range 非法或无法满足（route 映射为 416）
   */
  resolveRead(
    key: string,
    rangeHeader?: string | null
  ): Promise<AudioStorageReadResult>;
}

/** 对象不存在（route 映射为 404；DB 侧不得借此改写 segment ready，M8-02 只读已有资产） */
export class AudioObjectNotFoundError extends Error {
  readonly key: string;
  constructor(key: string) {
    // 中文注释：错误信息不携带 key 明文之外的任何路径/桶信息；key 本身为 opaque。
    super(`audio object not found: ${key}`);
    this.name = 'AudioObjectNotFoundError';
    this.key = key;
  }
}

/** Range 无法满足（route 映射为 416 + `Content-Range: bytes star-slash-total`） */
export class StorageRangeNotSatisfiableError extends Error {
  readonly totalSize: number;
  constructor(totalSize: number) {
    super(`range not satisfiable, total size: ${totalSize}`);
    this.name = 'StorageRangeNotSatisfiableError';
    this.totalSize = totalSize;
  }
}

// ============================================================================
// StorageKey 安全守卫（path traversal 防护；Local 与 S3 共用同一口径）
// ============================================================================

/**
 * storageKey 合法性判定（backend-neutral）。
 *
 * 允许：相对路径段（字母/数字/`.`/`_`/`-`/`/`），且：
 * - 非空、不以 `/` 开头（禁止绝对路径）；
 * - 不含反斜杠（禁止 Windows 分隔符混入）；
 * - 按 `/` 切分后任一段不得为空、`.`、`..`（禁止空段与 parent 跳出）；
 * - 不含控制字符与空格。
 *
 * 说明：canonical 写入侧恒用 `story-audio/<uuid>.mp3`（见 lib/audio/manifest.ts），
 * 此处守卫保持通用相对 key 口径，不把 UUID 正则写死进存储层。
 */
export function isSafeStorageKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0 || key.length > 512) return false;
  if (key.startsWith('/')) return false;
  if (key.includes('\\')) return false;
  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  if (/(^|\/)\s|\s($|\/)/.test(key)) return false;
  const segments = key.split('/');
  for (const seg of segments) {
    if (seg.length === 0 || seg === '.' || seg === '..') return false;
    if (!/^[A-Za-z0-9._-]+$/.test(seg)) return false;
  }
  return true;
}

/**
 * 断言 storageKey 合法；非法抛 Error（调用方按 4xx 处理，绝不触及文件系统）。
 */
export function assertSafeStorageKey(key: string): void {
  if (!isSafeStorageKey(key)) {
    throw new Error(`invalid storage key: ${key}`);
  }
}

// ============================================================================
// Range 解析（RFC 7233 单区间子集；backend-neutral 纯函数，spec §19.2/§48）
// ============================================================================

/** Range 解析结果：full（无头 → 200）/ range（命中 → 206）/ invalid（→ 416） */
export type ParsedRangeOutcome =
  | { kind: 'full' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'invalid' };

/**
 * 解析 HTTP Range 头（只支持单区间 `bytes=`；多区间视为 invalid → 416）。
 *
 * 覆盖（spec §48）：
 * - 缺省/空头 → full；
 * - `bytes=0-99` → {0,99}；
 * - `bytes=100-` → {100,totalSize-1}；
 * - 后缀 `bytes=-N` → 末 N 字节（N>=total 时钳制为全文）；
 * - end 越界钳制（如 `bytes=0-99999` 在 total=1000 时 → {0,999}）；
 * - 其它（无 `bytes=` 前缀、非数字、start>end、start>=total、后缀 N<=0、多区间）→ invalid。
 */
export function parseRangeHeader(
  header: string | null | undefined,
  totalSize: number
): ParsedRangeOutcome {
  if (header === null || header === undefined) return { kind: 'full' };
  const trimmed = header.trim();
  if (trimmed.length === 0) return { kind: 'full' };
  if (!Number.isInteger(totalSize) || totalSize < 0) return { kind: 'invalid' };

  const match = /^bytes=([^,]+)$/.exec(trimmed);
  if (!match) return { kind: 'invalid' };
  // 含逗号即多区间（上式已拒绝），此处为防御性二次确认
  if (match[1].includes(',')) return { kind: 'invalid' };
  const spec = match[1].trim();

  // 后缀区间：bytes=-N
  const suffixMatch = /^-(\d+)$/.exec(spec);
  if (suffixMatch) {
    const suffixLength = Number(suffixMatch[1]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { kind: 'invalid' };
    }
    if (totalSize === 0) return { kind: 'invalid' };
    const clamped = Math.min(suffixLength, totalSize);
    return {
      kind: 'range',
      start: totalSize - clamped,
      end: totalSize - 1,
    };
  }

  const rangeMatch = /^(\d+)-(\d*)$/.exec(spec);
  if (!rangeMatch) return { kind: 'invalid' };
  const start = Number(rangeMatch[1]);
  const endRaw = rangeMatch[2];
  if (!Number.isSafeInteger(start)) return { kind: 'invalid' };
  if (start >= totalSize) return { kind: 'invalid' };
  let end: number;
  if (endRaw === '') {
    end = totalSize - 1;
  } else {
    end = Number(endRaw);
    if (!Number.isSafeInteger(end)) return { kind: 'invalid' };
    if (end >= totalSize) end = totalSize - 1;
  }
  if (end < start) return { kind: 'invalid' };
  return { kind: 'range', start, end };
}
