import type {
  PlaybackSourceType,
  PlaybackProgressDTO,
  SavePlaybackProgressInput,
} from '@/lib/trpc/schemas/playback';

export type {
  PlaybackSourceType,
  PlaybackProgressDTO,
  SavePlaybackProgressInput,
};

export interface PlaybackGenerationContext {
  voiceId: string;
  speed: number;
  remainingAllowedMs?: number | null;
  totalAllowedMs?: number | null;
  isOneShot: boolean;
}

export interface PlaybackSourceLocator {
  sourceType: PlaybackSourceType;
  sourceId: string;
  sessionId?: string | null;
  title: string;
}

export interface PlaybackParagraphState {
  lastCompletedParagraphIndex: number;
  nextParagraphIndex: number;
  totalParagraphs: number;
}

export interface PlaybackFingerprint {
  contentHash: string;
  segmentationVersion: string;
}
