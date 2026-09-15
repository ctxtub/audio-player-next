/**
 * M7-01 NowPlaying 正式 import surface（M6-04 命名迁移收官 + M7 Expanded UI Store）。
 * M9-03：FloatingPlayer 兼容 shim 已删除，新代码一律从本 surface 导入正式命名。
 */

export { MiniNowPlaying, default } from './MiniNowPlaying';
export {
    deriveMiniCoarseProgress,
    deriveMiniNowPlayingViewModel,
    deriveMiniPlaybackAction,
    deriveMiniSecondaryLabel,
    deriveMiniTitle,
    hasMiniNowPlaying,
    mapSessionStatusToMiniStatus,
} from './deriveMiniNowPlayingViewModel';
export { MiniMetadataButton, MiniPlaybackButton, MiniProgressRail } from './presentation';
export {
    createExpandedNowPlayingEntryController,
    useNowPlayingEntry,
    type NowPlayingEntryController,
} from './useNowPlayingEntry';
export {
    ExpandedNowPlaying,
    EXPANDED_DIALOG_ARIA_LABEL,
    EXPANDED_SHEET_DISMISS_THRESHOLD_PX,
    formatExpandedSubtitle,
} from './ExpandedNowPlaying';
export type { ExpandedLocalView } from './ExpandedNowPlaying';
export {
    MINI_METADATA_TRIGGER_SELECTOR,
    NowPlayingLayer,
    shouldAutoCloseExpanded,
} from './NowPlayingLayer';
export {
    NowPlayingHeader,
    NOW_PLAYING_DRAG_HANDLE_LABEL,
    NOW_PLAYING_HEADER_CLOSE_LABEL,
} from './NowPlayingHeader';
export {
    deriveExpandedNowPlayingViewModel,
    deriveExpandedParagraph,
    deriveExpandedSleepTimer,
    deriveExpandedTitle,
    deriveExpandedVoiceLabel,
    deriveExpandedTimeline,
    deriveExpandedPlaybackRate,
    deriveExpandedCanRestart,
    deriveExpandedCanViewStory,
    deriveExpandedCanViewTranscript,
    deriveDraftTranscriptText,
    deriveTranscriptDisplayText,
    deriveWorkLibraryTarget,
    EXPANDED_NOW_PLAYING_FALLBACK_TITLE,
    EXPANDED_VOICE_FALLBACK_LABEL,
    useExpandedNowPlayingViewModel,
    type ExpandedNowPlayingViewModel,
    type ExpandedParagraphViewModel,
    type ExpandedSleepTimerViewModel,
    type ExpandedTimelineViewModel,
    type ExpandedTransportViewModel,
} from './useExpandedNowPlayingViewModel';
export { useExpandedPlaybackControls, type ExpandedPlaybackControls } from './useExpandedPlaybackControls';
export {
    PlaybackTimeline,
    EXPANDED_TIMELINE_MODE,
    EXPANDED_TIMELINE_ARIA_LABEL,
    EXPANDED_TIMELINE_KEYBOARD_STEP_SECONDS,
    formatSegmentTime,
    resolveClickSeekTarget,
    resolveKeyboardSeekTarget,
} from './PlaybackTimeline';
export {
    PlaybackControls,
    deriveExpandedPlaybackAction,
    type ExpandedPlaybackAction,
} from './PlaybackControls';
export {
    PlaybackRateControl,
    EXPANDED_PLAYBACK_RATES,
    formatPlaybackRateLabel,
    isSupportedPlaybackRate,
} from './PlaybackRateControl';
export { ParagraphStatus, formatParagraphStatus } from './ParagraphStatus';
export {
    SleepTimerControl,
    deriveSleepTimerControlModel,
    isValidCustomSleepTimerMinutes,
    type SleepTimerControlProps,
    type SleepTimerSelection,
} from './SleepTimerControl';
export { NowPlayingActions, type NowPlayingActionsProps } from './NowPlayingActions';
export { TranscriptView, type TranscriptViewProps } from './TranscriptView';
export {
    EXPANDED_TRANSCRIPT_TESTID,
    EXPANDED_TRANSCRIPT_TEXT_TESTID,
    EXPANDED_TRANSCRIPT_EMPTY_TESTID,
    EXPANDED_VIEW_TRANSCRIPT_BUTTON_TESTID,
    EXPANDED_TRANSCRIPT_BACK_BUTTON_TESTID,
    EXPANDED_OPEN_WORK_DETAIL_BUTTON_TESTID,
    TRANSCRIPT_BACK_LABEL,
    OPEN_WORK_DETAIL_LABEL,
    TRANSCRIPT_EMPTY_LABEL,
    normalizeDraftTranscriptText,
    resolveDraftTranscriptText,
    resolveTranscriptDisplayText,
    shouldShowDraftTranscript,
    decideDraftTranscript,
    type DraftTranscriptDecision,
    type DraftTranscriptDecisionInput,
} from './draftTranscript';
export {
    VIEW_STORY_LABEL,
    EXPANDED_ACTIONS_TESTID,
    EXPANDED_VIEW_STORY_BUTTON_TESTID,
    LIBRARY_ROUTE_BASE,
    resolveWorkLibraryTarget,
    shouldShowWorkViewStory,
    normalizeLibraryPathname,
    isSameLibraryDetail,
    decideWorkViewStoryNavigation,
    type WorkViewStoryNavigationInput,
    type WorkViewStoryNavigationDecision,
} from './workViewStoryNavigation';
export {
    BACK_TO_CREATION_LABEL,
    CONTINUE_CREATION_LABEL,
    EXPANDED_BACK_TO_CREATION_BUTTON_TESTID,
    EXPANDED_CONTINUE_CREATION_BUTTON_TESTID,
    CHAT_ROUTE,
    shouldShowDraftBackToCreation,
    shouldShowWorkContinueCreation,
    resolveBackToCreationTarget,
    decideDraftBackToCreation,
    decideWorkContinueCreation,
    type DraftBackToCreationDecision,
    type DraftBackToCreationDecisionInput,
    type WorkContinueCreationDecision,
    type WorkContinueCreationDecisionInput,
} from './creationActions';
export {
    NOW_PLAYING_BREAKPOINT_PX,
    resolveNowPlayingLayoutMode,
    resolveViewportMode,
    useNowPlayingLayoutMode,
    useViewportMode,
    type MiniNowPlayingLayoutMode,
    type NowPlayingViewportMode,
} from './useNowPlayingLayoutMode';
export { shouldTreatAsKeyboardOpen, useSoftKeyboardState } from './useSoftKeyboardState';
export {
    MINI_FLOATING_MARGIN_X_PX,
    MINI_FLOATING_MARGIN_Y_PX,
    clampFloatingPosition,
    resolveFloatingDragEnd,
    resolveFloatingSnapSide,
    snapFloatingToEdge,
    type MiniFloatingPanelSize,
    type MiniFloatingPosition,
    type MiniFloatingSnapSide,
    type MiniFloatingViewportSize,
} from './MiniFloatingGeometry';
export { useMiniFloatingDrag, type MiniFloatingDrag } from './useMiniFloatingDrag';
export {
    MINI_NOW_PLAYING_FALLBACK_TITLE,
    NOW_PLAYING_BREAKPOINT_PX as NOW_PLAYING_BREAKPOINT_PX_FROM_TYPES,
    type MiniNowPlayingStatus,
    type MiniNowPlayingViewModel,
    type MiniPlaybackAction,
    type MiniSessionSnapshot,
    type MiniTransportSnapshot,
    type SoftKeyboardSignal,
    type SoftKeyboardState,
} from './types';
