'use client';

import React from 'react';
import StoryViewer from '@/components/StoryViewer';
import PlaybackStatusBoard from '@/components/PlaybackStatusBoard';
import AudioPlayer from './components/AudioPlayer';

/**
 * 播放器页面内容组件，负责展示播放状态与故事列表。
 * @returns 播放器页面布局 JSX
 */
const PlayerContent: React.FC = () => {
  return (
    <div className="flex justify-center bg-[var(--page-background,transparent)] p-[var(--page-padding)]">
      <div className="w-full max-w-[720px]">
        <PlaybackStatusBoard className="mb-4" />
        <AudioPlayer />
        <StoryViewer />
      </div>
    </div>
  );
};

export default PlayerContent;
