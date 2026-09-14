/**
 * M8 Canonical Audio Manifest identity 组合逻辑（spec §5.2/§7–§9；M8-01 纯领域层）。
 *
 * 只放类型与纯函数，不计算真实 bytes、不触 DB、不调用 TTS。
 * Segment text 冻结：Manifest 创建时持久化 segmentIndex/text/textHash/storageKey，
 * text 为 frozen input，永不依赖未来版本的 segmentStoryText() 重新切分（spec §6.4）。 */

import { randomUUID } from 'node:crypto';
import { computeStoryContentHash } from '@/utils/segmentation';
import {
  CANONICAL_AUDIO_CONTENT_TYPE,
  CANONICAL_AUDIO_FORMAT,
  CANONICAL_SYNTHESIS_SPEED,
  type CanonicalAudioProfile,
} from './profile';

/** Manifest 冻结身份（spec §5.2 八元组；用户倍速/title/favorite 绝不进入） */
export type ManifestIdentity = {
  /** StoryWork.contentHash 快照 */
  contentHash: string;
  /** 切段算法版本快照 */
  segmentationVersion: string;
  /** 冻结 voice */
  voiceId: string;
  /** 冻结 backend 身份 */
  ttsBackendId: string;
  /** 冻结 model（authoritative pin） */
  ttsModel: string;
  /** 冻结合成管线版本 */
  synthesisVersion: string;
  /** 冻结音频格式 */
  audioFormat: string;
  /** 冻结合成速度（恒 1.0） */
  synthesisSpeed: typeof CANONICAL_SYNTHESIS_SPEED;
};

/** Manifest 身份字段顺序（identity key 序列化唯一顺序；增减字段必须同步更新单测） */
export const MANIFEST_IDENTITY_FIELDS = [
  'contentHash',
  'segmentationVersion',
  'voiceId',
  'ttsBackendId',
  'ttsModel',
  'synthesisVersion',
  'audioFormat',
  'synthesisSpeed',
] as const satisfies ReadonlyArray<keyof ManifestIdentity>;

/** Segment 冻结输入（Manifest 创建时逐段持久化；spec §6.4） */
export type FrozenSegmentInput = {
  /** Server 生成的不透明公开 ID（UUID v4） */
  id: string;
  segmentIndex: number;
  /** 冻结段文本（frozen input） */
  text: string;
  /** 沿用既有 computeStoryContentHash(text)，不另造正文 hash（spec §6.5） */
  textHash: string;
  /** Opaque 对象 key（story-audio/<uuid>.mp3） */
  storageKey: string;
  contentType: string;
};

/** UUID v4 文本格式（server-generated ID 断言用） */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** storageKey 格式：story-audio/<uuid>.mp3（opaque，不编码任何业务身份；spec §6.2） */
const STORAGE_KEY_RE =
  /^story-audio\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp3$/i;

/**
 * 由 Story 快照 + profile 组合 Manifest 冻结身份（纯函数）。
 * @param story StoryWork 快照（contentHash + segmentationVersion）
 * @param profile 已冻结的 Canonical TTS profile
 */
export function buildManifestIdentity(
  story: Pick<ManifestIdentity, 'contentHash' | 'segmentationVersion'>,
  profile: CanonicalAudioProfile
): ManifestIdentity {
  return {
    contentHash: story.contentHash,
    segmentationVersion: story.segmentationVersion,
    voiceId: profile.voiceId,
    ttsBackendId: profile.ttsBackendId,
    ttsModel: profile.ttsModel,
    synthesisVersion: profile.synthesisVersion,
    audioFormat: profile.audioFormat,
    synthesisSpeed: CANONICAL_SYNTHESIS_SPEED,
  };
}

/**
 * Manifest 身份相等判定（纯函数；仅比较八元组，调用方多传 title/favorite/rate 等字段不影响结果）。
 */
export function isSameManifestIdentity(
  a: ManifestIdentity,
  b: ManifestIdentity
): boolean {
  return computeManifestIdentityKey(a) === computeManifestIdentityKey(b);
}

/**
 * Manifest 身份稳定 key（纯函数；字段固定顺序 JSON 序列化，供相等/变化断言与日志）。
 */
export function computeManifestIdentityKey(identity: ManifestIdentity): string {
  const ordered: Record<string, string | number> = {};
  for (const field of MANIFEST_IDENTITY_FIELDS) {
    ordered[field] = identity[field];
  }
  return JSON.stringify(ordered);
}

/**
 * 由 segment UUID 派生 opaque storageKey（纯函数；spec §6.2/§6.3）。
 * key 只含 asset 自身 UUID，不编码 user/guest/work/title 任一业务身份，
 * 使 Guest→User 注册时 DB ownership 可 transfer 而 object bytes 不动（spec §27）。
 */
export function buildSegmentStorageKey(segmentId: string): string {
  return `story-audio/${segmentId}.mp3`;
}

/** 断言 storageKey 为合法 opaque key（格式 + 不含业务身份明文由调用方单测覆盖） */
export function isOpaqueStorageKey(storageKey: string): boolean {
  return STORAGE_KEY_RE.test(storageKey);
}

/** 断言 ID 为 server-generated UUID 形态 */
export function isServerGeneratedSegmentId(id: string): boolean {
  return UUID_V4_RE.test(id);
}

/**
 * 构建单段冻结输入（Manifest 创建时调用；不调用 TTS、不写 DB）。
 * text 原样冻结；textHash 复用既有 computeStoryContentHash；id/storageKey 由 service 生成。
 * @param segmentIndex 段序号（manifest 内从 0 起）
 * @param text 本次切分出的段文本（frozen input，之后不再重算）
 * @param generateId 可注入的 ID 生成器（默认 crypto.randomUUID；测试可注入确定性桩）
 */
export function buildFrozenSegmentInput(
  segmentIndex: number,
  text: string,
  generateId: () => string = randomUUID
): FrozenSegmentInput {
  const id = generateId();
  return {
    id,
    segmentIndex,
    text,
    textHash: computeStoryContentHash(text),
    storageKey: buildSegmentStorageKey(id),
    contentType: CANONICAL_AUDIO_CONTENT_TYPE,
  };
}

/**
 * 批量构建冻结段输入（Manifest 创建时对 segmentStoryText() 当次结果调用一次；
 * 调用后即持久化，未来切段算法升级不再重跑旧 Manifest，spec §6.4）。
 */
export function buildFrozenSegmentInputs(
  segmentTexts: string[],
  generateId?: () => string
): FrozenSegmentInput[] {
  return segmentTexts.map((text, index) =>
    buildFrozenSegmentInput(index, text, generateId)
  );
}

/** 默认 canonical 音频格式断言（与 profile 常量同源，防止两处分叉） */
export function isCanonicalAudioFormat(format: string): boolean {
  return format === CANONICAL_AUDIO_FORMAT;
}
