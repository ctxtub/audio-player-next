/**
 * M8 Canonical Audio 本地磁盘后端（spec §2.1/§19.2/§31；M8-02）。
 *
 * - root 可配（`AUDIO_LOCAL_ROOT`，缺省 `/app/audio`）；与 SQLite 目录解耦，
 *   绝不落入 DB 备份耦合目录（由 index.ts 配置层拒绝，见 LEGACY_COUPLED_AUDIO_DIR）。
 * - 读写经 `assertSafeStorageKey` + root 归一化双重防护，杜绝 path traversal。
 * - Range 语义与 S3 契约层一致：full → 200 口径，单区间 → 206 口径，
 *   非法/无法满足 → 抛 `StorageRangeNotSatisfiableError`（route 映射为 416）。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  assertSafeStorageKey,
  AudioObjectNotFoundError,
  parseRangeHeader,
  StorageRangeNotSatisfiableError,
  type AudioAssetStorage,
  type AudioObjectMetadata,
  type AudioStorageReadResult,
  type PutAudioObjectInput,
} from './types';

/** Local backend 缺省根（spec §3：`/app/audio`，独立 volume，与 `/app/data` 解耦） */
export const DEFAULT_LOCAL_AUDIO_ROOT = '/app/audio';

/** contentType sidecar 后缀（bytes 文件同目录同名 + 后缀；缺失时回落 canonical 缺省） */
const CONTENT_TYPE_SIDECAR_SUFFIX = '.contenttype';

/** canonical 缺省 content-type（与 lib/audio/profile.ts 同值；仅作 sidecar 缺失回落） */
const FALLBACK_CONTENT_TYPE = 'audio/mpeg';

export type LocalAudioStorageOptions = {
  /** 磁盘根目录（缺省读 `AUDIO_LOCAL_ROOT`，再缺省 `/app/audio`） */
  root?: string;
};

/**
 * 解析生效 root（纯函数，供配置层与单测共用；不触文件系统）。
 */
export function resolveLocalRoot(raw?: string | null): string {
  const candidate =
    raw !== undefined && raw !== null
      ? raw
      : (process.env.AUDIO_LOCAL_ROOT ?? '');
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_LOCAL_AUDIO_ROOT;
}

/** Local 文件系统后端（root 下相对 key 直存；同 key 覆盖写，spec §18.1） */
export class LocalFilesystemStorage implements AudioAssetStorage {
  private readonly root: string;

  constructor(options?: LocalAudioStorageOptions) {
    this.root = path.resolve(resolveLocalRoot(options?.root ?? null));
  }

  /** 生效 root（测试/诊断用；不暴露给客户端） */
  getRoot(): string {
    return this.root;
  }

  /**
   * key → 磁盘绝对路径（含 traversal 双重防护；非法 key 抛 Error 且不触文件系统）。
   */
  resolvePathForKey(key: string): string {
    assertSafeStorageKey(key);
    const abs = path.resolve(path.join(this.root, key));
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(`storage key escapes root: ${key}`);
    }
    return abs;
  }

  private sidecarPath(absPath: string): string {
    return `${absPath}${CONTENT_TYPE_SIDECAR_SUFFIX}`;
  }

  async put(input: PutAudioObjectInput): Promise<void> {
    assertSafeStorageKey(input.key);
    if (!(input.bytes instanceof Uint8Array)) {
      throw new Error('put bytes must be Uint8Array');
    }
    const abs = this.resolvePathForKey(input.key);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, input.bytes);
    await fs.promises.writeFile(
      this.sidecarPath(abs),
      input.contentType,
      'utf-8'
    );
  }

  async exists(key: string): Promise<boolean> {
    assertSafeStorageKey(key);
    try {
      const stat = await fs.promises.stat(this.resolvePathForKey(key));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeStorageKey(key);
    const abs = this.resolvePathForKey(key);
    // 中文注释：幂等删除（不存在亦成功），支撑 tombstone 清理重试（spec §29）。
    await fs.promises.rm(abs, { force: true });
    await fs.promises.rm(this.sidecarPath(abs), { force: true });
  }

  async getMetadata(key: string): Promise<AudioObjectMetadata | null> {
    assertSafeStorageKey(key);
    const abs = this.resolvePathForKey(key);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    let contentType = FALLBACK_CONTENT_TYPE;
    try {
      const raw = await fs.promises.readFile(this.sidecarPath(abs), 'utf-8');
      if (raw.trim().length > 0) contentType = raw.trim();
    } catch {
      // sidecar 缺失（历史/手工放置文件）→ 回落 canonical 缺省
    }
    return { size: stat.size, contentType };
  }

  async resolveRead(
    key: string,
    rangeHeader?: string | null
  ): Promise<AudioStorageReadResult> {
    assertSafeStorageKey(key);
    const abs = this.resolvePathForKey(key);
    let data: Buffer;
    try {
      data = await fs.promises.readFile(abs);
    } catch {
      throw new AudioObjectNotFoundError(key);
    }
    const meta = await this.getMetadata(key);
    // 中文注释：bytes 已读到但 stat 失败属异常 corrupt；按缺失处理（route → 404，不改 DB）。
    if (!meta) throw new AudioObjectNotFoundError(key);

    const parsed = parseRangeHeader(rangeHeader ?? null, data.byteLength);
    if (parsed.kind === 'invalid') {
      throw new StorageRangeNotSatisfiableError(data.byteLength);
    }
    if (parsed.kind === 'full') {
      return {
        kind: 'bytes',
        bytes: new Uint8Array(data),
        contentType: meta.contentType,
        totalSize: data.byteLength,
        range: null,
      };
    }
    return {
      kind: 'bytes',
      bytes: new Uint8Array(data.subarray(parsed.start, parsed.end + 1)),
      contentType: meta.contentType,
      totalSize: data.byteLength,
      range: { start: parsed.start, end: parsed.end },
    };
  }
}
