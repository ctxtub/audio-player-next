/**
 * tRPC 流观察 hook 类型声明（对应 scripts/e2e-stream-observe.mjs，缺陷 #7）。
 *
 * 说明：运行时实现为零依赖 .mjs（浏览器/Node 通用）；本文件仅供 tsc 类型检查。
 * 不含绝对路径、端口与密钥。
 */

/** 流成功证据三角互证固定项。 */
export type StreamSuccessEvidence = ['ui', 'server-log', 'downstream'];

/** 观测 verdict：结构上不存在 `failed`，杜绝把取消/消费类异常误记为失败。 */
export type ObserveVerdict = 'stream-established' | 'ok' | 'http-error' | 'cancelled' | 'error';

/** 非流 body 安全摘要。 */
export interface BodySummary {
    /** 原文长度（字符数）。 */
    length: number;
    /** 截断预览（不超 NON_STREAM_PREVIEW_CAP）。 */
    preview: string;
    /** 原文是否超出截断上限。 */
    truncated: boolean;
}

/** 流式观测记录：仅可验证元数据，从不含 body。 */
export interface StreamObserveRecord {
    kind: 'stream';
    /** 仅 pathname（query 已丢弃）。 */
    path: string;
    /** HTTP 状态码。 */
    status: number;
    /** content-type 主值。 */
    contentType: string;
    /** 响应头已到达（响应已建立）。 */
    established: boolean;
    /** 流成功证据固定为三角互证。 */
    successEvidence: StreamSuccessEvidence;
    verdict: ObserveVerdict;
}

/** 非流观测记录：安全 body 摘要。 */
export interface BodyObserveRecord {
    kind: 'body';
    /** 仅 pathname（query 已丢弃）。 */
    path: string;
    /** HTTP 状态码。 */
    status: number;
    /** 安全摘要。 */
    summary: BodySummary;
    /** body 不可读时的备注。 */
    note?: string;
    verdict: ObserveVerdict;
}

/** 请求期观测记录（fetch 实现直接抛错时）。 */
export interface RequestObserveRecord {
    kind: 'request';
    /** 仅 pathname（query 已丢弃）。 */
    path: string;
    verdict: ObserveVerdict;
    /** 截断后的错误信息。 */
    message: string;
}

/** 观测记录联合类型。 */
export type ObserveRecord = StreamObserveRecord | BodyObserveRecord | RequestObserveRecord;

/** 观察 fetch 创建选项。 */
export interface ObservingFetchOptions {
    /** 流路径片段表（覆盖默认值，命中其一即按流处理）。 */
    streamingPaths?: string[];
}

/** 底层 fetch 实现签名。 */
export type FetchLike = (url: string, init?: unknown) => Promise<Response>;

/** 非流 body 摘要预览截断上限（字符数）。 */
export const NON_STREAM_PREVIEW_CAP: number;

/** 错误信息记录截断上限（字符数）。 */
export const OBSERVE_MESSAGE_CAP: number;

/** 流成功证据三角互证固定项。 */
export const STREAM_SUCCESS_EVIDENCE: StreamSuccessEvidence;

/** 默认流式路径片段。 */
export const DEFAULT_STREAMING_PATHS: string[];

/**
 * 从请求地址提取仅 pathname 的观测路径。
 * @param url 请求地址（绝对或相对）。
 */
export function extractObservePath(url: string): string;

/**
 * 判定响应是否应按流处理。
 */
export function isStreamingLike(args: {
    path: string;
    contentType: string;
    bodyLocked: boolean;
    streamingPaths?: string[];
}): boolean;

/**
 * 把观察期异常归类为取消或真实错误。
 * @param err 捕获到的异常。
 */
export function classifyObserveError(err: unknown): 'cancelled' | 'error';

/**
 * 对非流 body 文本生成安全摘要。
 * @param text body 文本。
 */
export function summarizeBodySafely(text: string): BodySummary;

/**
 * 创建观察 fetch 包装。
 * @param fetchImpl 底层 fetch 实现。
 * @param options 选项（流路径表覆盖）。
 */
export function createObservingFetch(
    fetchImpl: FetchLike,
    options?: ObservingFetchOptions,
): { fetch: FetchLike; records: ObserveRecord[] };
