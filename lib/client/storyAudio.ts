/**
 * M8 Canonical Audio Client Facade（M8-03；M8-04 增补 Work 播放读路径 provider 选择）。
 *
 * 仅透出 storyAudio 两个 canonical procedures 的类型安全门面：
 * - getPlaybackManifest({ workId })：只读投影；
 * - ensureSegment({ workId, segmentIndex, sessionId })：lazy 按需就绪。
 *
 * 约束：客户端只发 workId/segmentIndex/sessionId，永不构造、不持久化
 * text/audio/profile/storageKey；storageKey 不作为 DTO/API 字段暴露。
 *
 * M8-04（spec §22–§23）：
 * - Work 播放段落音源选择：`shouldUseCanonicalAudio(source)` 为 true 时走
 *   canonical（ensureSegment → ready playbackUrl），否则走 legacy ephemeral TTS；
 *   Draft 恒走旧路径（调用方按 source.kind 分支，本模块不隐式判断 Draft）。
 * - Segmentation SSOT：`selectWorkParagraphs(local, manifest)`——Manifest 已存在
 *   （segments 非空）时 Work 播放段落文本 SSOT = Manifest.segments[].text，
 *   不得重新跑未来版本 segmentStoryText()；无 Manifest 时回落本地切分，
 *   第一次真正请求 segment 时 ensureSegment 侧 lazy create manifest。
 */

import { trpc } from '@/lib/trpc/client';
import { isCanonicalAudioEnabled } from '@/lib/audio/canonicalFlag';
import type { PlaybackSourceRef } from '@/lib/playback/source';

export type {
  EnsureStoryAudioSegmentInput,
  GetPlaybackManifestInput,
  PlaybackManifest,
  PlaybackManifestSegment,
  StoryAudioStatus,
  EnsureSegmentOutput,
  EnsureSegmentReady,
  EnsureSegmentPreparing,
} from '@/lib/trpc/schemas/storyAudio';

/**
 * 读取播放用 Manifest 投影（纯结构体入参）。
 */
export const getPlaybackManifest = async (input: {
  workId: number;
}): Promise<
  import('@/lib/trpc/schemas/storyAudio').PlaybackManifest
> => {
  return trpc.storyAudio.getPlaybackManifest.query(input);
};

/**
 * 按需确保单 Segment canonical 就绪（纯结构体入参）。
 */
export const ensureSegment = async (input: {
  workId: number;
  segmentIndex: number;
  sessionId: string;
}): Promise<import('@/lib/trpc/schemas/storyAudio').EnsureSegmentOutput> => {
  return trpc.storyAudio.ensureSegment.mutate(input);
};

export const storyAudioClient = {
  getPlaybackManifest,
  ensureSegment,
};

/**
 * M8-04 Work Segment audio provider 选择（只替换 provider，不动 M5 identity）。
 *
 * - source.kind === 'work' 且 canonical flag 开启 → true（走 ensureSegment）；
 * - Draft（含 replay-text-* 瞬态）恒 false（走旧 tts.synthesize）；
 * - flag 关闭时一律 false（legacy ephemeral，production 默认）。
 *
 * @param source 当前 Session source（null → false）
 */
export function shouldUseCanonicalAudio(source: PlaybackSourceRef | null): boolean {
  if (!source || source.kind !== 'work') return false;
  try {
    return isCanonicalAudioEnabled();
  } catch {
    return false;
  }
}

/**
 * M8-04 Segmentation SSOT 选择（spec §23，纯函数）。
 *
 * Manifest 已存在（segments 非空）→ 返回 Manifest.segments[].text（frozen，
 * 与未来版本 segmentStoryText() 解耦，保证 audio index == playback index）；
 * 无 Manifest（null/segments 空）→ 返回本地切分（首次请求时 ensure 侧 lazy 建）。
 *
 * @param localParagraphs 本地 segmentStoryText() 结果（无 Manifest 时回落）
 * @param manifest getPlaybackManifest 投影（null 表示无 Manifest）
 */
export function selectWorkParagraphs(
  localParagraphs: string[],
  manifest: {
    segments: Array<{ index: number; text: string }>;
  } | null,
): string[] {
  if (!manifest || !Array.isArray(manifest.segments) || manifest.segments.length === 0) {
    return localParagraphs;
  }
  const ordered = [...manifest.segments].sort((a, b) => a.index - b.index);
  return ordered.map((s) => s.text);
}

/**
 * Canonical playbackUrl 形态守卫（/api/audio/segments/<opaque-id>）。
 * stale 丢弃时仅 blob: 才 revokeObjectURL，canonical URL 永不 revoke。
 */
export function isCanonicalPlaybackUrl(url: string): boolean {
  return typeof url === 'string' && url.startsWith('/api/audio/segments/');
}
