/**
 *  Canonical Audio 纯哈希函数（spec §6.5/§6.6； 纯领域层）。
 *
 * 严格区分两种哈希，用途绝不混用：
 * - contentHash / textHash：正文身份，沿用既有 computeStoryContentHash（FNV 短哈希），
 *   本文件不实现、只 re-export 供 audio 域统一入口；
 * - audioChecksum：音频 blob 完整性，SHA-256(audio bytes)，密码学哈希在此合理（spec §6.6）。
 */

import { createHash } from 'node:crypto';
import { computeStoryContentHash } from '@/utils/segmentation';

export { computeStoryContentHash };

/** SHA-256 hex 格式（64 位小写十六进制） */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * 计算音频 blob SHA-256 校验和（纯函数；写入 Segment.audioChecksum）。
 * @param bytes TTS 返回的音频字节（MP3）
 * @returns 64 位小写十六进制字符串
 */
export function computeAudioChecksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 断言 audioChecksum 格式合法 */
export function isValidAudioChecksum(checksum: string): boolean {
  return SHA256_HEX_RE.test(checksum);
}
