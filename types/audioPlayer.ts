/**
 * 音频播放器控制器定义，封装全局可调用的控制方法。
 */
export interface AudioControllerHandle {
  /**
   * 解锁音频播放能力，解决移动端首次播放的手势限制。
   * @returns 完成解锁动作的 Promise
   */
  unlock: () => Promise<void>;
  /**
   * 播放指定音频资源，并在内部完成加载与重置。
   * @param audioUrl 音频文件的访问地址
   * @param messageId 可选：关联的消息 ID
   * @returns 代表异步播放过程的 Promise
   */
  play: (audioUrl: string, messageId?: string) => Promise<void>;
  /**
   * 恢复暂停的音频播放。
   * @returns 代表异步恢复过程的 Promise
   */
  resume: () => Promise<void>;
  /**
   * 暂停音频播放。
   * @returns void
   */
  pause: () => void;
  /**
   * 跳转到音频指定时间点。
   * @param time 目标播放时间（秒）
   * @returns void
   */
  seek: (time: number) => void;
  /**
   * 设置音频播放速率。
   * @param rate 目标倍速
   * @returns void
   */
  setPlaybackRate: (rate: number) => void;
}
