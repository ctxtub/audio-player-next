/**
 *  Canonical Audio MP3 duration 解析（spec §17；）。
 *
 * Server-side 纯 Node 解析生成后 MP3 的 duration，不引入 ffmpeg/ffprobe
 *（Docker 轻量 Node Alpine 保持，spec §17），亦不新增外部 metadata 依赖：
 * 直接解析 MPEG Audio frame header，累计 samples / sampleRate。
 *
 * - 输入：TTS 返回的 MP3 bytes（canonical 为 mp3，contentType audio/mpeg）。
 * - 输出：整数毫秒（四舍五入）；无有效帧时抛 Mp3DurationParseError。
 * - Manifest 仅当全部 Segment ready 且都有 duration 才 ready（spec §17.1）：
 *   未获得 duration 不得标 ready，由调用方（lib/server/storyAudio.ts）fail-closed。
 * - 只是可信 metadata；不得顺手实现 story-level timeline（ 禁项）。
 */

const MPEG1_SAMPLE_RATES = [44100, 48000, 32000, 0];
const MPEG2_SAMPLE_RATES = [22050, 24000, 16000, 0];
const MPEG25_SAMPLE_RATES = [11025, 12000, 8000, 0];

/** MPEG1 Layer I/II/III bitrate 表（index 0/15 无效；单位 kbps） */
const MPEG1_BITRATES = [
  [0, 0, 0, 0],
  [32, 32, 32, 32],
  [64, 48, 40, 48],
  [96, 56, 48, 56],
  [128, 64, 56, 64],
  [160, 80, 64, 80],
  [192, 96, 80, 96],
  [224, 112, 96, 112],
  [256, 128, 112, 128],
  [288, 160, 128, 160],
  [320, 192, 160, 192],
  [352, 224, 192, 224],
  [384, 256, 224, 256],
  [416, 320, 256, 320],
  [448, 384, 320, 384],
  [0, 0, 0, 0],
];

/** MPEG2/2.5 Layer I/II/III bitrate 表（单位 kbps） */
const MPEG2_BITRATES = [
  [0, 0, 0, 0],
  [32, 32, 8, 8],
  [48, 48, 16, 16],
  [56, 56, 24, 24],
  [64, 64, 32, 32],
  [80, 80, 40, 40],
  [96, 96, 48, 48],
  [112, 112, 56, 56],
  [128, 128, 64, 64],
  [144, 144, 80, 80],
  [160, 160, 96, 96],
  [176, 176, 112, 112],
  [192, 192, 128, 128],
  [224, 224, 144, 144],
  [256, 256, 160, 160],
  [0, 0, 0, 0],
];

/** duration 解析失败（调用方映射为 AUDIO_SYNTHESIS_FAILED，不得标 ready） */
export class Mp3DurationParseError extends Error {
  constructor(message = 'invalid mp3: no decodable audio frame') {
    super(message);
    this.name = 'Mp3DurationParseError';
  }
}

/**
 * 跳过 ID3v2 头（若存在），返回首帧偏移。
 * ID3v2: "ID3" + ver(2) + flags(1) + syncsafe size(4)。
 */
function skipId3v2(bytes: Uint8Array): number {
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33
  ) {
    const size =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f);
    const total = 10 + size;
    if (total >= 0 && total <= bytes.length) return total;
  }
  return 0;
}

type FrameInfo = {
  frameSize: number;
  samples: number;
  sampleRate: number;
};

/**
 * 解析偏移处 MPEG frame header（需 4 字节）。
 * @returns null 表示此处非有效帧头
 */
function parseFrameHeader(
  bytes: Uint8Array,
  offset: number
): FrameInfo | null {
  if (offset + 4 > bytes.length) return null;
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  if (versionBits === 1 || layerBits === 0) return null;
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  const paddingBit = (b2 >> 1) & 0x01;
  if (bitrateIndex === 0 || bitrateIndex === 15) return null;

  const isMpeg1 = versionBits === 3;
  const isMpeg2 = versionBits === 2;
  // const isMpeg25 = versionBits === 0;

  let sampleRate: number;
  if (isMpeg1) sampleRate = MPEG1_SAMPLE_RATES[sampleRateIndex];
  else if (isMpeg2) sampleRate = MPEG2_SAMPLE_RATES[sampleRateIndex];
  else sampleRate = MPEG25_SAMPLE_RATES[sampleRateIndex];
  if (!sampleRate) return null;

  // layerBits: 3=I, 2=II, 1=III → 列索引：0=I,1=II,2=III(与 bitrate 表列对齐：表列为 I,II,III)
  const layerCol = layerBits === 3 ? 0 : layerBits === 2 ? 1 : 2;
  const bitrateKbps = isMpeg1
    ? MPEG1_BITRATES[bitrateIndex][layerCol]
    : MPEG2_BITRATES[bitrateIndex][layerCol];
  if (!bitrateKbps) return null;
  const bitrate = bitrateKbps * 1000;

  const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;
  let frameSize: number;
  let samples: number;
  if (layer === 1) {
    frameSize = Math.floor((12 * bitrate) / sampleRate + paddingBit) * 4;
    samples = 384;
  } else if (layer === 3 && !isMpeg1) {
    // MPEG2/2.5 Layer III：slot 72，单帧 576 samples
    frameSize = Math.floor((72 * bitrate) / sampleRate + paddingBit);
    samples = 576;
  } else {
    frameSize = Math.floor((144 * bitrate) / sampleRate + paddingBit);
    samples = layer === 3 ? 1152 : 1152;
  }
  if (frameSize < 21 || offset + frameSize > bytes.length) {
    // 尾部截断帧：若剩余不足一帧则视为无效（调用方整体 fail-closed）
    // 但需区分“真截断”与“header 误命中”：此处一律返回 null 由扫描前进一步。
    return null;
  }
  // 下一帧 sync 校验（非尾帧时）：避免误命中 payload 中的 0xFFE 伪同步。
  // 尾帧（恰好到末尾）不校验。
  if (offset + frameSize + 2 <= bytes.length) {
    const n0 = bytes[offset + frameSize];
    const n1 = bytes[offset + frameSize + 1];
    if (n0 !== 0xff || (n1 & 0xe0) !== 0xe0) {
      // 下一位置非 sync：可能是 ID3v1（128B TAG）或填充，直接判本帧无效交由扫描步进。
      // 例外：剩余恰为 ID3v1 TAG（"TAG" 开头 128B）时仍承认本帧有效。
      const remaining = bytes.length - (offset + frameSize);
      const tagStart = offset + frameSize;
      const isId3v1 =
        remaining === 128 &&
        bytes[tagStart] === 0x54 &&
        bytes[tagStart + 1] === 0x41 &&
        bytes[tagStart + 2] === 0x47;
      if (!isId3v1) return null;
    }
  }
  void b3;
  return { frameSize, samples, sampleRate };
}

/**
 * 计算 MP3 bytes 的 duration（毫秒，整数）。
 * @param bytes TTS 返回的 MP3 字节
 * @returns 四舍五入后的毫秒数（>0）
 * @throws {Mp3DurationParseError} 无有效帧或输入为空
 */
export function getMp3DurationMs(bytes: Uint8Array): number {
  if (!(bytes instanceof Uint8Array) || bytes.length < 21) {
    throw new Mp3DurationParseError();
  }
  let offset = skipId3v2(bytes);
  // 跳过 ID3v1 预留：末 128B TAG 不参与帧扫描（parseFrameHeader 尾帧例外已处理）
  let end = bytes.length;
  if (
    end - 128 >= offset &&
    bytes[end - 128] === 0x54 &&
    bytes[end - 127] === 0x41 &&
    bytes[end - 126] === 0x47
  ) {
    end -= 128;
  }
  let totalSamples = 0;
  let sampleRate = 0;
  let frames = 0;
  while (offset + 4 <= end) {
    // 快扫到下一个 0xFF（帧同步起点）
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const info = parseFrameHeader(bytes, offset);
    if (!info) {
      offset += 1;
      continue;
    }
    if (sampleRate === 0) sampleRate = info.sampleRate;
    // 混流（中途变采样率）按首帧采样率累计 samples（canonical 单 TTS 输出恒同参）
    totalSamples += info.samples;
    frames += 1;
    offset += info.frameSize;
  }
  if (frames === 0 || sampleRate === 0 || totalSamples === 0) {
    throw new Mp3DurationParseError();
  }
  const ms = Math.round((totalSamples / sampleRate) * 1000);
  if (!Number.isFinite(ms) || ms <= 0) throw new Mp3DurationParseError();
  return ms;
}

/**
 * 判定 duration 合法（正整数毫秒）。
 */
export function isValidDurationMs(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    Number.isSafeInteger(value)
  );
}
