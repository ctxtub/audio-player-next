/**
 * 故事接口支持的模式：生成或续写。
 */
export type StoryMode = 'generate' | 'continue';

/**
 * 首次生成故事时使用的请求体结构。
 */
export type StoryGenerateRequest = {
  mode: 'generate';
  prompt: string;
};

/**
 * 续写故事时可选的附加配置。
 */
export type StoryContinueOptions = {
  withSummary?: boolean;
};

/**
 * 续写故事时使用的请求体结构。
 */
export type StoryContinueRequest = {
  mode: 'continue';
  prompt: string;
  storyContent: string;
  withSummary?: boolean;
};

/**
 * 故事生成接口统一的请求体联合类型。
 */
export type StoryApiRequest = StoryGenerateRequest | StoryContinueRequest;

/**
 * 故事生成接口的响应体结构。
 */
export type StoryApiResponse = {
  storyContent: string;
  summaryContent?: string | null;
};
