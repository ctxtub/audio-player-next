declare global {
  interface Window {
    gtag: (
      command: 'event',
      action: string,
      params: {
        event_category?: string;
        event_label?: string;
        value?: number;
        [key: string]: any;
      }
    ) => void;
  }
}

export interface APIConfig {
  version: number;
  playDuration: number;
  voiceName: string;
}

export type ThemeMode = 'dark' | 'light' | 'system';
