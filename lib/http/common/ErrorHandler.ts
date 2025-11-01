export type HttpErrorPayload = {
  code?: string;
  message: string;
  status: number;
  details?: unknown;
};

/**
 * 统一的 HTTP 错误对象，封装状态码与响应体。
 */
export class HttpError extends Error {
  public readonly status: number;
  public readonly code?: string;
  public readonly details?: unknown;

  constructor(payload: HttpErrorPayload) {
    super(payload.message);
    this.name = 'HttpError';
    this.status = payload.status;
    this.code = payload.code;
    this.details = payload.details;
  }
}

export const isHttpError = (error: unknown): error is HttpError =>
  error instanceof HttpError;
