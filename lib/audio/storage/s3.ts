/**
 * M8 Canonical Audio S3-compatible 后端（spec §2.2/§19.3；M8-02）。
 *
 * - Bucket 恒为 private（禁止公开 ACL，spec §3）；读取 = 短时签名 URL，
 *   App Node 不代理实际音频流量（route 收到 redirect 后返回 307）。
 * - Range 由对象存储原生处理：`resolveRead` 忽略 Range 头，直接签发 GET URL。
 * - 本文件是全仓唯一允许直接 import S3 SDK 的生产模块
 *  （由单测静态守卫锁定；测试经 `S3Driver` 缝注入 fake，不触 SDK/网络/MinIO）。
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  assertSafeStorageKey,
  AudioObjectNotFoundError,
  type AudioAssetStorage,
  type AudioObjectMetadata,
  type AudioStorageReadResult,
  type PutAudioObjectInput,
} from './types';

/** 短时签名 URL 缺省 TTL（秒，spec §3：900） */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 900;

/** S3 连接配置（secret 只存内存，永不打印/永不落日志） */
export type S3ConnectionOptions = {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  signedUrlTtlSeconds?: number;
};

/**
 * S3 驱动缝（真实实现见 `createS3Driver`；测试注入内存 fake）。
 * 以窄方法契约隔离 SDK，保证业务语义单测无需 SDK mock、无需 MinIO（spec §49）。
 */
export type S3Driver = {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  head(key: string): Promise<AudioObjectMetadata | null>;
  delete(key: string): Promise<void>;
  signGet(key: string): Promise<string>;
};

export type S3AudioStorageDeps = {
  bucket: string;
  signedUrlTtlSeconds?: number;
  driver: S3Driver;
};

function requireNonEmpty(value: string | undefined, envName: string): string {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) {
    // 中文注释：只报缺失的变量名，不回显任何值（secret 永不打印）。
    throw new Error(`missing required audio storage config: ${envName}`);
  }
  return trimmed;
}

/**
 * 解析签名 URL TTL（纯函数；缺省 900；非法抛错）。
 */
export function resolveSignedUrlTtlSeconds(
  raw?: string | number | null
): number {
  if (raw === undefined || raw === null || String(raw).trim().length === 0) {
    return DEFAULT_SIGNED_URL_TTL_SECONDS;
  }
  const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error('invalid audio storage config: AUDIO_SIGNED_URL_TTL_SECONDS');
  }
  return num;
}

/**
 * 解析布尔型 S3 配置（`true`/`1`/`yes` 视为 true；缺省 false）。
 */
export function parseS3ForcePathStyle(raw?: string | null): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/**
 * 由连接配置构建真实 S3 驱动（生产路径；secret 仅传入 SDK client，不做任何输出）。
 */
export function createS3Driver(options: S3ConnectionOptions): S3Driver {
  const bucket = requireNonEmpty(options.bucket, 'AUDIO_S3_BUCKET');
  const region = requireNonEmpty(options.region, 'AUDIO_S3_REGION');
  const accessKeyId = requireNonEmpty(
    options.accessKeyId,
    'AUDIO_S3_ACCESS_KEY_ID'
  );
  const secretAccessKey = requireNonEmpty(
    options.secretAccessKey,
    'AUDIO_S3_SECRET_ACCESS_KEY'
  );
  const ttl = resolveSignedUrlTtlSeconds(options.signedUrlTtlSeconds ?? null);
  const endpoint = (options.endpoint ?? '').trim();

  const client = new S3Client({
    region,
    ...(endpoint.length > 0 ? { endpoint } : {}),
    forcePathStyle: options.forcePathStyle ?? false,
    credentials: { accessKeyId, secretAccessKey },
  });

  const isNotFound = (err: unknown): boolean => {
    if (typeof err !== 'object' || err === null) return false;
    const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
    if (e.name === 'NotFound' || e.name === 'NoSuchKey') return true;
    return e.$metadata?.httpStatusCode === 404;
  };

  return {
    async put(key: string, bytes: Uint8Array, contentType: string) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
        })
      );
    },
    async head(key: string) {
      try {
        const out = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key })
        );
        if (typeof out.ContentLength !== 'number') return null;
        return {
          size: out.ContentLength,
          contentType: out.ContentType ?? 'audio/mpeg',
        };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async delete(key: string) {
      // 中文注释：S3 删除天然幂等（不存在亦成功），与 tombstone 重试语义一致。
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async signGet(key: string) {
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: ttl }
      );
    },
  };
}

/** S3-compatible 后端（bucket private；读取恒为短时签名 URL redirect） */
export class S3AudioAssetStorage implements AudioAssetStorage {
  private readonly bucket: string;
  private readonly signedUrlTtlSeconds: number;
  private readonly driver: S3Driver;

  constructor(deps: S3AudioStorageDeps) {
    const bucket = (deps.bucket ?? '').trim();
    if (bucket.length === 0) {
      throw new Error('missing required audio storage config: bucket');
    }
    this.bucket = bucket;
    this.signedUrlTtlSeconds = resolveSignedUrlTtlSeconds(
      deps.signedUrlTtlSeconds ?? null
    );
    this.driver = deps.driver;
  }

  /** 生效 bucket 名（测试/诊断用；不暴露给客户端） */
  getBucket(): string {
    return this.bucket;
  }

  async put(input: PutAudioObjectInput): Promise<void> {
    assertSafeStorageKey(input.key);
    if (!(input.bytes instanceof Uint8Array)) {
      throw new Error('put bytes must be Uint8Array');
    }
    await this.driver.put(input.key, input.bytes, input.contentType);
  }

  async exists(key: string): Promise<boolean> {
    assertSafeStorageKey(key);
    return (await this.driver.head(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    assertSafeStorageKey(key);
    await this.driver.delete(key);
  }

  async getMetadata(key: string): Promise<AudioObjectMetadata | null> {
    assertSafeStorageKey(key);
    return this.driver.head(key);
  }

  // 中文注释：Range 由对象存储原生处理，故忽略 Range 头（接口保留参数以契约一致）。
  async resolveRead(
    key: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _rangeHeader?: string | null
  ): Promise<AudioStorageReadResult> {
    assertSafeStorageKey(key);
    // 中文注释：先 head 确认存在（缺失 → 404，不签发无意义 URL；Range 由对象存储原生处理）。
    const meta = await this.driver.head(key);
    if (!meta) throw new AudioObjectNotFoundError(key);
    const url = await this.driver.signGet(key);
    return { kind: 'redirect', url };
  }
}
