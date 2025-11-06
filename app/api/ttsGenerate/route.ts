import { NextResponse } from 'next/server';

import { ServiceError } from "@/lib/http/server/ErrorHandler";
import { loadTtsConfig, synthesizeSpeech } from "@/lib/server/ttsUpstream";
import type { TtsGeneratePayload, VoiceOption } from "@/types/ttsGenerate";

/**
 * 语音合成接口允许的最大文本长度。
 */
const MAX_TEXT_LENGTH = 2000;

/**
 * 统一构建错误响应的工具函数。
 * @param status HTTP 状态码。
 * @param code 业务错误码。
 * @param message 错误描述。
 */
const buildErrorResponse = (status: number, code: string, message: string) =>
  NextResponse.json(
    {
      error: {
        code,
        message,
      },
    },
    { status },
  );

/**
 * 将文本内容裁剪并折叠空白字符，保证传入 SDK 的内容合法。
 * @param text 原始文本。
 */
const normalizeText = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * 判断请求中的语音 ID 是否在白名单中。
 * @param voiceId 请求提供的语音标识。
 * @param voices 白名单列表。
 */
const isVoiceAllowed = (voiceId: string, voices: VoiceOption[]): boolean =>
  voices.some((voice) => voice.value === voiceId);

/**
 * 校验并规范化客户端传入的语音合成请求。
 * @param payload 原始请求体。
 * @throws ServiceError 当文本非法或参数缺失时抛出。
 */
const normalizeRequest = (payload: unknown): { text: string; voiceId: string } => {
  const config = loadTtsConfig();

  if (!payload || typeof payload !== "object") {
    throw new ServiceError({
      message: "请求体必须是对象",
      status: 400,
      code: "INVALID_REQUEST",
    });
  }

  const source = payload as Partial<TtsGeneratePayload>;
  const rawText =
    typeof source.text === "string"
      ? source.text
      : source.text == null
        ? ""
        : String(source.text);

  const normalizedText = normalizeText(rawText);
  if (!normalizedText) {
    throw new ServiceError({
      message: "text 不能为空",
      status: 400,
      code: "INVALID_REQUEST",
    });
  }

  if (normalizedText.length > MAX_TEXT_LENGTH) {
    throw new ServiceError({
      message: "文本长度超过限制",
      status: 400,
      code: "TEXT_TOO_LONG",
    });
  }

  const requestedVoice =
    typeof source.voiceId === "string" && source.voiceId.trim()
      ? source.voiceId.trim()
      : undefined;

  const voiceId = requestedVoice && isVoiceAllowed(requestedVoice, config.voicesList)
    ? requestedVoice
    : config.voiceId;

  return {
    text: normalizedText,
    voiceId,
  };
};

/**
 * 处理语音合成请求。
 * @param req Next.js 请求对象。
 * @returns 包含音频流的 Response。
 */
export const POST = async (req: Request) => {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch (error) {
    return buildErrorResponse(
      400,
      "INVALID_JSON",
      `请求体不是合法的 JSON: ${error instanceof Error ? error.message : "未知错误"}`,
    );
  }

  let normalized: { text: string; voiceId: string };
  try {
    normalized = normalizeRequest(payload);
  } catch (error) {
    if (error instanceof ServiceError) {
      return buildErrorResponse(error.status, error.code, error.message);
    }

    return buildErrorResponse(500, "INTERNAL_SERVER_ERROR", "语音合成服务发生未知错误");
  }

  try {
    const result = await synthesizeSpeech({
      text: normalized.text,
      voiceId: normalized.voiceId,
    });

    const audioBuffer = Buffer.from(result.audioData);
    const headers = new Headers({
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    });

    if (result.requestId) {
      headers.set("x-azure-request-id", result.requestId);
    }

    return new NextResponse(audioBuffer, {
      status: 200,
      headers,
    });
  } catch (error) {
    if (error instanceof ServiceError) {
      return buildErrorResponse(error.status, error.code, error.message);
    }

    return buildErrorResponse(500, "INTERNAL_SERVER_ERROR", "语音合成服务发生未知错误");
  }
};
