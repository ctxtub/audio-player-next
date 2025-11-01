export type StoryMode = 'generate' | 'continue';

export type StoryApiRequest = {
  mode: StoryMode;
  prompt: string;
  storyContent?: string;
  withSummary?: boolean;
};

export type StoryApiResponse = {
  story: string;
  summary?: string | null;
};
