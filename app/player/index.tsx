'use client';

import React from 'react';
import StoryViewer from '@/components/StoryViewer';
import PlaybackStatusBoard from '@/components/PlaybackStatusBoard';
import AudioPlayer from './components/AudioPlayer';
import styles from './index.module.scss';

/**
 * 播放器页面内容组件，负责展示播放状态与故事列表。
 * @returns 播放器页面布局 JSX
 */
const PlayerContent: React.FC = () => {
  return (
    <div className={styles.playerPage}>
      <div className={styles.playerContainer}>
        <PlaybackStatusBoard
          className={styles.statusBoard}
        />
        <AudioPlayer />
        <StoryViewer />
      </div>
    </div>
  );
};

export default PlayerContent;
