/**
 *  Canonical Audio Storage 装配入口（spec §3/§3.1；）。
 *
 * 按 `AUDIO_STORAGE_DRIVER=s3|local` 二选一装配 canonical backend；
 * 不是 local+S3 双写，不做 Hot Cache（spec §2.3/§2.4）。
 *
 * 业务层唯一入口：`getAudioAssetStorage()`。绝不直接 import `./local`/`./s3`
 * 之外的 SDK 或构造 filesystem path / bucket URL。
 */

import path from 'node:path';
import {
  LocalFilesystemStorage,
  resolveLocalRoot,
} from './local';
import {
  createS3Driver,
  parseS3ForcePathStyle,
  resolveSignedUrlTtlSeconds,
  S3AudioAssetStorage,
  type S3Driver,
} from './s3';
import type { AudioAssetStorage } from './types';

export type { AudioAssetStorage };
export { DEFAULT_LOCAL_AUDIO_ROOT } from './local';
export { DEFAULT_SIGNED_URL_TTL_SECONDS } from './s3';

/** 存储驱动二选一（spec §3） */
export type AudioStorageDriverName = 'local' | 's3';

/**
 * 历史耦合目录（spec §2.1：禁止 `./data/audio`，DB backup 与 Audio backup 必须解耦）。
 * Local root 落入此目录（本身或其子目录）即视为配置错误，启动期 fail-fast。
 */
export const LEGACY_COUPLED_AUDIO_DIR = '/app/data/audio';

/** Local 配置快照（已解析、可打印；不含任何 secret） */
export type LocalStorageConfig = {
  driver: 'local';
  localRoot: string;
};

/** S3 配置快照（已解析、可打印；绝不含 secret 明文） */
export type S3StorageConfig = {
  driver: 's3';
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  signedUrlTtlSeconds: number;
  /** 是否配置了 accessKey（仅布尔存在信号，永不回显值） */
  hasAccessKeyId: boolean;
  /** 是否配置了 secret（仅布尔存在信号，永不回显值） */
  hasSecretAccessKey: boolean;
};

export type ResolvedAudioStorageConfig = LocalStorageConfig | S3StorageConfig;

export type EnvLike = {
  AUDIO_STORAGE_DRIVER?: string | undefined;
  AUDIO_LOCAL_ROOT?: string | undefined;
  AUDIO_S3_ENDPOINT?: string | undefined;
  AUDIO_S3_REGION?: string | undefined;
  AUDIO_S3_BUCKET?: string | undefined;
  AUDIO_S3_ACCESS_KEY_ID?: string | undefined;
  AUDIO_S3_SECRET_ACCESS_KEY?: string | undefined;
  AUDIO_S3_FORCE_PATH_STYLE?: string | undefined;
  AUDIO_SIGNED_URL_TTL_SECONDS?: string | undefined;
};

/**
 * 解析存储驱动名（纯函数；缺省 local；大小写不敏感；非法抛错）。
 */
export function resolveStorageDriverName(
  raw?: string | null
): AudioStorageDriverName {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized.length === 0) return 'local';
  if (normalized === 'local' || normalized === 's3') return normalized;
  throw new Error(
    'invalid audio storage config: AUDIO_STORAGE_DRIVER must be s3|local'
  );
}

/**
 * 判定 Local root 是否落入历史耦合目录（纯函数；相等或其子目录即命中）。
 */
export function isCoupledLegacyAudioRoot(resolvedRoot: string): boolean {
  const normalized = resolvedRoot.trim().replace(/\/+$/, '');
  if (normalized === LEGACY_COUPLED_AUDIO_DIR) return true;
  return normalized.startsWith(`${LEGACY_COUPLED_AUDIO_DIR}/`);
}

function readEnv(env: EnvLike | undefined): EnvLike {
  if (env) return env;
  return process.env as EnvLike;
}

/**
 * 解析完整存储配置（纯函数；S3 缺必需项抛错且只报变量名；secret 永不回显）。
 */
export function resolveAudioStorageConfig(
  env?: EnvLike
): ResolvedAudioStorageConfig {
  const e = readEnv(env);
  const driver = resolveStorageDriverName(e.AUDIO_STORAGE_DRIVER ?? null);
  if (driver === 'local') {
    // 中文注释：先 canonicalize（resolve 归一化 `.`/`..`/尾斜杠与相对路径）再判定，
    // 使 `/app/data/./audio` 等路径别名无法绕过耦合目录 fail-fast；返回 canonical path。
    const localRoot = path.resolve(resolveLocalRoot(e.AUDIO_LOCAL_ROOT ?? null));
    if (isCoupledLegacyAudioRoot(localRoot)) {
      throw new Error(
        'invalid audio storage config: AUDIO_LOCAL_ROOT must not be under /app/data (use an independent volume)'
      );
    }
    return { driver, localRoot };
  }
  const endpoint = (e.AUDIO_S3_ENDPOINT ?? '').trim();
  const region = (e.AUDIO_S3_REGION ?? '').trim();
  const bucket = (e.AUDIO_S3_BUCKET ?? '').trim();
  const accessKeyId = (e.AUDIO_S3_ACCESS_KEY_ID ?? '').trim();
  const secretAccessKey = (e.AUDIO_S3_SECRET_ACCESS_KEY ?? '').trim();
  if (region.length === 0) {
    throw new Error('missing required audio storage config: AUDIO_S3_REGION');
  }
  if (bucket.length === 0) {
    throw new Error('missing required audio storage config: AUDIO_S3_BUCKET');
  }
  if (accessKeyId.length === 0) {
    throw new Error(
      'missing required audio storage config: AUDIO_S3_ACCESS_KEY_ID'
    );
  }
  if (secretAccessKey.length === 0) {
    throw new Error(
      'missing required audio storage config: AUDIO_S3_SECRET_ACCESS_KEY'
    );
  }
  return {
    driver,
    endpoint,
    region,
    bucket,
    forcePathStyle: parseS3ForcePathStyle(e.AUDIO_S3_FORCE_PATH_STYLE ?? null),
    signedUrlTtlSeconds: resolveSignedUrlTtlSeconds(
      e.AUDIO_SIGNED_URL_TTL_SECONDS ?? null
    ),
    hasAccessKeyId: true,
    hasSecretAccessKey: true,
  };
}

/** 单例装配覆盖（测试注入 fake driver 用；生产调用方不得使用） */
export type AudioStorageFactoryOverrides = {
  s3Driver?: S3Driver;
};

let cachedStorage: AudioAssetStorage | null = null;

/**
 * 获取 canonical backend 单例（按配置二选一；同一进程恒同一实例）。
 */
export function getAudioAssetStorage(
  env?: EnvLike,
  overrides?: AudioStorageFactoryOverrides
): AudioAssetStorage {
  if (cachedStorage) return cachedStorage;
  const config = resolveAudioStorageConfig(env);
  if (config.driver === 'local') {
    cachedStorage = new LocalFilesystemStorage({ root: config.localRoot });
    return cachedStorage;
  }
  const e = readEnv(env);
  const driver =
    overrides?.s3Driver ??
    createS3Driver({
      bucket: config.bucket,
      region: config.region,
      endpoint: config.endpoint,
      accessKeyId: (e.AUDIO_S3_ACCESS_KEY_ID ?? '').trim(),
      secretAccessKey: (e.AUDIO_S3_SECRET_ACCESS_KEY ?? '').trim(),
      forcePathStyle: config.forcePathStyle,
      signedUrlTtlSeconds: config.signedUrlTtlSeconds,
    });
  cachedStorage = new S3AudioAssetStorage({
    bucket: config.bucket,
    signedUrlTtlSeconds: config.signedUrlTtlSeconds,
    driver,
  });
  return cachedStorage;
}

/**
 * 重置存储单例（测试专用；生产代码严禁调用）。
 */
export function resetAudioAssetStorageForTests(): void {
  cachedStorage = null;
}

/**
 * 直接设定存储单例（测试专用：route 层 S3 redirect 语义验证用 fake；生产严禁）。
 */
export function setAudioAssetStorageForTests(
  storage: AudioAssetStorage
): void {
  cachedStorage = storage;
}
