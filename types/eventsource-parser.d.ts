/**
 * `eventsource-parser` 第三方库的最小类型定义，满足 BFF 层 SSE 解析的编译需求。
 */
declare module 'eventsource-parser' {
  export type EventSourceMessage = {
    /** 事件名称，例如 message、done。 */
    event: string;
    /** 事件携带的数据文本。 */
    data: string;
    /** 可选的事件 id。 */
    id?: string;
  };

  export type ParseError = Error & {
    /** 解析失败的错误信息。 */
    message: string;
  };

  export type EventSourceParser = {
    /** 向解析器推入新的文本片段。 */
    feed: (chunk: string) => void;
    /** 重置解析器状态。 */
    reset: () => void;
  };

  export function createParser(callbacks: {
    /** 成功解析到事件时的回调。 */
    onEvent: (event: EventSourceMessage) => void;
    /** 解析异常时的回调。 */
    onError?: (error: ParseError) => void;
  }): EventSourceParser;
}
