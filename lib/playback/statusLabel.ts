import type { PlaybackSessionStatus } from '@/stores/playbackSessionStore';

/** 所有播放入口共用会话状态文案；选中身份不能代替播放状态。 */
export function playbackStatusLabel(status: PlaybackSessionStatus): string {
  switch (status) {
    case 'playing': return '正在播放';
    case 'paused':
    case 'ready': return '已暂停';
    case 'ended': return '播放完成';
    case 'hydrating':
    case 'synthesizing': return '正在准备语音';
    case 'error': return '播放遇到问题';
    case 'idle': return '未播放';
  }
}
