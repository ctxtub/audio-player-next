export type ServiceErrorOptions = {
  message: string;
  status: number;
  code: string;
  details?: unknown;
  cause?: unknown;
};

/**
 * 统一的服务端业务错误基类，用于在 API 层和日志中保留状态、错误码及追踪信息。
 */
export class ServiceError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly cause?: unknown;

  constructor(options: ServiceErrorOptions) {
    super(options.message);
    this.name = 'ServiceError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.cause = options.cause;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
