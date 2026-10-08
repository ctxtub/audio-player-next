'use client';
import { useState } from 'react';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { playStoryWork } from '@/app/services/playbackSessionFlow';
import GlassToast from '@/components/ui/GlassToast';
import styles from './storyControls.module.scss';
/** 所有内容页面共用同一播放意图与实时状态。 */
export function WorkPlaybackButton({ workId, title, testId }: { workId: number; title: string; testId?: string }) {
  const [pending, setPending] = useState(false);
  const current = usePlaybackSessionStore((state) => state.source?.kind === 'work' && state.source.workId === workId);
  const status = usePlaybackSessionStore((state) => state.status);
  const playing = usePlaybackStore((state) => state.isPlaying);
  const busy = pending || (current && (status === 'hydrating' || status === 'synthesizing'));
  const label = busy ? '准备语音…' : current && playing ? '暂停' : current && status === 'ended' ? '重新播放' : current ? '继续播放' : '播放';
  return <button type="button" className={styles.play} disabled={busy} data-testid={testId} aria-label={`${label}《${title}》`} onClick={async () => {
    setPending(true);
    try { await playStoryWork(workId); } catch { GlassToast.show({ icon: 'fail', content: '暂时无法播放，请重试' }); } finally { setPending(false); }
  }}>{label}</button>;
}
