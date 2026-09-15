/**
 * M8 Canonical Audio TTS 身份配置（spec §5.3/§5.4 + §8/§9；M8-01 纯领域层）。
 *
 * 只放类型、常量与纯解析函数，不读取音频 bytes、不调用 TTS、不触 DB。
 * 真实合成入口 synthesizeSpeechWithProfile() 留待 M8-03（正式拆分口径）。
 */

/** TTS backend 稳定身份默认值（非 secret；OPENAI_BASE_URL 可指向不同后端时仅靠 model 不足以表达真实身份，spec §5.3） */
export const DEFAULT_TTS_BACKEND_ID = 'openai';

/** TTS_BACKEND_ID 环境变量名（部署按后端别名配置，如 company-proxy-v1；缺省回落 openai） */
export const TTS_BACKEND_ID_ENV_VAR = 'TTS_BACKEND_ID';

/**
 * 合成管线版本（应用自定，非 Provider model version；spec §5.4）。
 * 请求 format / normalization / canonical speed / 后处理 / loudness / encoder /
 * TTS 请求语义任一变化即 bump。当前冻结值：canonical-mp3-v1。
 */
export const SYNTHESIS_VERSION = 'canonical-mp3-v1';

/** Canonical 音频格式（MP3； response_format=mp3，contentType audio/mpeg） */
export const CANONICAL_AUDIO_FORMAT = 'mp3';

/** Canonical 音频 content-type（与 Segment.contentType 默认一致） */
export const CANONICAL_AUDIO_CONTENT_TYPE = 'audio/mpeg';

/**
 * Canonical 合成速度恒为 1.0（spec §7 / M8-P02）。
 * 用户倍速一律由 HTMLAudioElement.playbackRate 实现，绝不进入 asset 身份、
 * 不创建新 Manifest、不重新 TTS、不改 duration metadata。
 */
export const CANONICAL_SYNTHESIS_SPEED = 1.0 as const;

/** OPENAI_TTS_MODEL 缺省回落（与 lib/server/openai.ts getTtsConfig fallback 同值；M8-02 统一收敛） */
export const FALLBACK_TTS_MODEL = 'tts-1';

/** OPENAI_TTS_MODEL 环境变量名 */
export const TTS_MODEL_ENV_VAR = 'OPENAI_TTS_MODEL';

/** Canonical TTS profile：Manifest 创建时冻结，后续缺失 Segment 的 authoritative 参数（spec §9） */
export type CanonicalAudioProfile = {
  /** 冻结 voice（Work.voiceId 优先；legacy 空串则 resolve 默认 voice 后冻结，spec §8） */
  voiceId: string;
  /** 冻结 backend 身份 */
  ttsBackendId: string;
  /** 冻结 model（部署改配置不影响旧 Manifest 未生成段，spec §9） */
  ttsModel: string;
  /** 冻结合成管线版本 */
  synthesisVersion: string;
  /** 冻结音频格式 */
  audioFormat: string;
  /** 冻结合成速度（恒 1.0） */
  synthesisSpeed: typeof CANONICAL_SYNTHESIS_SPEED;
};

/** Audio 状态四态（Manifest 与 Segment 共用；spec §12） */
export type AudioStatus = 'missing' | 'preparing' | 'ready' | 'failed';

/**
 * 解析 TTS backend 身份（纯函数；默认读 TTS_BACKEND_ID，空串回落 openai）。
 * @param raw 显式输入（测试/调用方可直传；缺省时读环境）
 */
export function resolveTtsBackendId(raw?: string | null): string {
  const candidate =
    raw !== undefined && raw !== null
      ? raw
      : (process.env[TTS_BACKEND_ID_ENV_VAR] ?? '');
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_TTS_BACKEND_ID;
}

/**
 * 解析 TTS model（纯函数；默认读 OPENAI_TTS_MODEL，空串回落 tts-1，与 getTtsConfig 一致）。
 * @param raw 显式输入（缺省时读环境）
 */
export function resolveTtsModel(raw?: string | null): string {
  const candidate =
    raw !== undefined && raw !== null
      ? raw
      : (process.env[TTS_MODEL_ENV_VAR] ?? '');
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : FALLBACK_TTS_MODEL;
}

/**
 * 解析 Manifest voice（纯函数；spec §8）。
 * Work.voiceId 优先；legacy 空串则取当前默认 voice 并由调用方回填 StoryWork.voiceId。
 * @param workVoiceId StoryWork 当前 voiceId（可为空串）
 * @param defaultVoiceId 当前配置默认 voice
 */
export function resolveManifestVoiceId(
  workVoiceId: string | null | undefined,
  defaultVoiceId: string
): string {
  const work = (workVoiceId ?? '').trim();
  if (work.length > 0) return work;
  return defaultVoiceId.trim();
}

/**
 * 冻结 Canonical TTS profile（纯函数）。
 * 输入 speed 一律被忽略并锁定 1.0：调用方传用户倍速也不会污染身份（spec §7.1）。
 */
export function freezeCanonicalAudioProfile(input: {
  voiceId: string;
  ttsBackendId: string;
  ttsModel: string;
  synthesisVersion?: string;
  audioFormat?: string;
  /** 接受但恒被覆盖（防误用：用户倍速不得进入 profile） */
  synthesisSpeed?: number;
}): CanonicalAudioProfile {
  return {
    voiceId: input.voiceId,
    ttsBackendId: input.ttsBackendId,
    ttsModel: input.ttsModel,
    synthesisVersion: input.synthesisVersion ?? SYNTHESIS_VERSION,
    audioFormat: input.audioFormat ?? CANONICAL_AUDIO_FORMAT,
    synthesisSpeed: CANONICAL_SYNTHESIS_SPEED,
  };
}
