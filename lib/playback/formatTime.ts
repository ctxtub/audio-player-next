/** Format playback time in seconds as M:SS. Invalid or negative values become 0:00. */
export const formatPlaybackTime = (seconds: number): string => {
  const safe = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.floor(safe / 60);
  const remainder = Math.floor(safe % 60);
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
};
