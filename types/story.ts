/**
 * 故事接口支持的模式：生成或续写。
 */
export type StoryMode = 'generate' | 'continue';

/**
 * 故事生成 API 请求体。
 */
export type StoryApiRequest = {
  mode: StoryMode;
  prompt: string;
  storyContent?: string;
  withSummary?: boolean;
};

/**
 * 故事生成 API 响应体。
 */
export type StoryApiResponse = {
  story: string;
  summary?: string | null;
};
