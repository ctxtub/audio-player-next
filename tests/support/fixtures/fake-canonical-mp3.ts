/**
 * M8-03 Fake TTS 已知 MP3 夹具（spec §50；真实 OpenAI 禁止进入自动测试）。
 *
 * 合成确定性有效 MP3：N 个 MPEG1 Layer III 128kbps/44100Hz/stereo 帧
 *（header FF FB 90 00 + 413 零填充 = 417B/帧，1152 samples/帧）。
 * duration = round(N*1152/44100*1000)ms，可由 lib/audio/duration.ts 精确解析。
 */

import { createHash } from 'node:crypto';

/** 单帧字节数（144*128000/44100 无 padding） */
export const FAKE_MP3_FRAME_SIZE = 417;

/** 单帧 header（MPEG1 LayerIII 128k 44.1k stereo） */
const FAKE_FRAME_HEADER = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);

/** 默认帧数（10 帧 → 4170B → 261ms） */
export const FAKE_MP3_DEFAULT_FRAMES = 10;

/**
 * 构建确定性 fake MP3（每帧 header + 零填充；payload 可按 seed 微调以区分不同文本）。
 * @param frames 帧数
 * @param seed 区分不同段文本的种子（0-255；写入每帧尾字节，不影响 header 解析）
 */
export function buildFakeCanonicalMp3(
  frames: number = FAKE_MP3_DEFAULT_FRAMES,
  seed: number = 0
): Uint8Array {
  const out = new Uint8Array(frames * FAKE_MP3_FRAME_SIZE);
  for (let i = 0; i < frames; i += 1) {
    const base = i * FAKE_MP3_FRAME_SIZE;
    out.set(FAKE_FRAME_HEADER, base);
    // 尾字节按 seed+index 微调，使不同文本的 checksum 可区分但仍为有效帧
    out[base + FAKE_MP3_FRAME_SIZE - 1] = (seed + i) & 0xff;
  }
  return out;
}

/** 已知夹具：10 帧默认 MP3 */
export function knownFakeMp3(): Uint8Array {
  return buildFakeCanonicalMp3(FAKE_MP3_DEFAULT_FRAMES, 0);
}

/** 已知夹具期望 duration（与 getMp3DurationMs 同公式） */
export function expectedFakeMp3DurationMs(
  frames: number = FAKE_MP3_DEFAULT_FRAMES
): number {
  return Math.round((frames * 1152) / 44100 * 1000);
}

/** 已知夹具期望 checksum（SHA-256 hex） */
export function expectedFakeMp3Checksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
