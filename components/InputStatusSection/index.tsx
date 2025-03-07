import React, { useState, useEffect, useRef } from 'react';
import { CSSTransition } from 'react-transition-group';
import { Toast } from '../Toast';
import ClockIcon from '@/public/icons/playstatus-clock.svg';
import LoadingIcon from '@/public/icons/playstatus-loading.svg';
import WarningIcon from '@/public/icons/playstatus-warning.svg';
import CheckIcon from '@/public/icons/playstatus-check.svg';
import ArrowUpIcon from '@/public/icons/arrow-up.svg';
import ArrowDownIcon from '@/public/icons/arrow-down.svg';
import HistoryRecords, { HistoryRecord, HistoryRecordsRef } from '../HistoryRecords';

import styles from './index.module.scss';

interface InputStatusSectionProps {
  // StoryInput props
  inputText: string;
  isFirstStoryLoading: boolean;
  handleSubmit: (text: string) => void;

  // PlayStatusSection props
  remainingTime: number | null;
  isPreloadLoading: boolean;
  preloadRetryCount: number;
  preloadErrorMsg: string;
  preloadAudioUrl: string | null;
}

const InputStatusSection: React.FC<InputStatusSectionProps> = ({
  // StoryInput props
  inputText,
  isFirstStoryLoading,
  handleSubmit,
  
  // PlayStatusSection props
  remainingTime,
  isPreloadLoading,
  preloadRetryCount,
  preloadErrorMsg,
  preloadAudioUrl,
}) => {
  const [textareaInput, setTextareaInput] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const [isStartedFirstGeneration, setIsStartedFirstGeneration] = useState(false);
  const historyRecordsRef = useRef<HistoryRecordsRef>(null);
  const loadingOverlayRef = useRef<HTMLDivElement>(null);

  // 预设故事类型及其描述
  const storyTypes = [
    { label: '自然冥想', content: '意象冥想，放松身心，呼吸引导' },
    { label: '奇幻童话', content: '魔法世界，可爱角色，神奇冒险，正义战胜邪恶' },
    { label: '太空科幻', content: '未来科技，宇宙飞船，星际探险，未知星球' },
    { label: '睡前治愈', content: '温柔语速，温馨情节，抚慰心灵' },
    { label: '冒险悬疑', content: '紧张节奏，神秘事件，线索推理，反转结局' },
    // 将最后一个按钮替换为历史记录按钮
  ];

  useEffect(() => {
    setTextareaInput(inputText);
  }, [inputText]);

  const toggleExpanded = () => {
    setIsExpanded(prev => !prev);
  };

  // 保存提示词到历史记录
  const savePromptToHistory = (prompt: string) => {
    try {
      const now = new Date().toISOString();
      const savedHistory = localStorage.getItem('promptHistory');
      let historyObj: Record<string, HistoryRecord> = {};
      
      if (savedHistory) {
        historyObj = JSON.parse(savedHistory);
      }
      
      // 查找是否已存在相同提示词
      if (historyObj[prompt]) {
        // 更新现有记录
        historyObj[prompt].useCount += 1;
        historyObj[prompt].lastUsed = now;
      } else {
        // 添加新记录
        historyObj[prompt] = {
          prompt,
          lastUsed: now,
          useCount: 1
        };
      }
      
      // 保存回 localStorage
      localStorage.setItem('promptHistory', JSON.stringify(historyObj));
    } catch (error) {
      console.error('Error saving prompt history:', error);
    }
  };

  // 处理快捷按钮点击
  const handleQuickSelect = (content: string) => {
    handleSubmitWithHistory(content);
  };

  // 从历史记录中选择提示词
  const handleSelectHistoryPrompt = (prompt: string) => {
    handleSubmitWithHistory(prompt);
  };
  
  // 处理input提交
  const onSubmit = () => {
    if (!textareaInput || textareaInput.trim() === '') {
      Toast({ message: '请输入故事概要，再生成故事哦~' });
      return;
    }
    handleSubmitWithHistory(textareaInput);
  };

  // 包装 handleSubmit 以添加历史记录功能
  const handleSubmitWithHistory = (text: string) => {
    // 改变组件成播放态
    setIsStartedFirstGeneration(true);
    // 保存提示词到历史记录
    savePromptToHistory(text);
    // 调用父组件的 handleSubmit
    handleSubmit(text);
  };

  const formatCountdown = (minutes: number): string => {
    const wholeMinutes = Math.floor(minutes);
    const seconds = Math.floor((minutes - wholeMinutes) * 60);
    return `${wholeMinutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const handleHistoryButtonClick = () => {
    historyRecordsRef.current?.showModal();
  };

  // 触发首次故事生成即转为播放态，展示折叠态UI
  const containerClass = isStartedFirstGeneration
    ? `${styles.container} ${styles.playing}` : styles.container;

  // 未触发首次故事生成，输入框展示。触发首次故事生成后，根据isExpanded状态切换展开收缩状态
  const inputContentClass =  !isStartedFirstGeneration
    ? styles.inputContent : isExpanded
    ? styles.inputContent : `${styles.inputContent} ${styles.unExpanded}`;

  return (
    <div className={containerClass}>
      <CSSTransition
        in={isFirstStoryLoading}
        timeout={300}
        classNames={{
          enter: styles.loadingEnter,
          enterActive: styles.loadingEnterActive,
          exit: styles.loadingExit,
          exitActive: styles.loadingExitActive,
        }}
        unmountOnExit
        nodeRef={loadingOverlayRef}
      >
        <div ref={loadingOverlayRef} className={styles.loadingOverlay}>
          <div className={styles.loadingBar}>
            <div className={styles.loadingBarProgress}></div>
          </div>
        </div>
      </CSSTransition>

      {isStartedFirstGeneration && (
        <div className={styles.playingContent}>
          <div className={styles.statusItems}>
            {remainingTime !== null && (
              <div className={`${styles.statusItem} ${styles.countdown}`}>
                <ClockIcon className={styles.statusIcon} />
                <span>播放倒计时: {formatCountdown(remainingTime)}</span>
              </div>
            )}

            {isPreloadLoading && (
              <div className={`${styles.statusItem} ${styles.loading}`}>
                <LoadingIcon className={styles.statusIcon} />
                <span>
                  预加载中...
                  {preloadRetryCount > 0 && ` (第${preloadRetryCount}次重试)`}
                </span>
              </div>
            )}

            {preloadErrorMsg && (
              <div className={`${styles.statusItem} ${styles.error}`}>
                <WarningIcon className={styles.statusIcon} />
                <span>
                  预加载失败: {preloadErrorMsg}
                  {preloadRetryCount < 3 && ` (即将重试)`}
                </span>
              </div>
            )}

            {preloadAudioUrl && !isPreloadLoading && (
              <div className={`${styles.statusItem} ${styles.success}`}>
                <CheckIcon className={styles.statusIcon} />
                <span>下一段内容已准备就绪</span>
              </div>
            )}
          </div>
          
          <div className={styles.collapsedInput}>
            <span className={styles.collapsedText}>
              {inputText ? `故事概要: ${inputText.length > 30 ? inputText.substring(0, 30) + '...' : inputText}` : '故事概要'}
            </span>
          </div>
        </div>
      )}

      <div className={inputContentClass}>
        <div className={styles.quickButtons}>
          {storyTypes.map((type, index) => (
            <button
              key={index}
              className={styles.quickButton}
              onClick={() => handleQuickSelect(type.content)}
              title={type.content}
            >
              {type.label}
            </button>
          ))}
          <button 
            className={`${styles.quickButton} ${styles.historyButton}`}
            onClick={handleHistoryButtonClick}
            title="查看历史提示词记录"
          >
            历史记录
          </button>
        </div>
        <div className={styles.inputButtonContainer}>
          <textarea
            value={textareaInput}
            onChange={(e) => setTextareaInput(e.target.value)}
            placeholder="输入你想听的故事概要..."
            rows={2}
            className={styles.storyInput}
          />
          <button
            className={styles.generateButton}
            onClick={onSubmit}
          >
            生成故事
          </button>
        </div>
      </div>
      
      {isStartedFirstGeneration && (
        <div className={styles.toggleArrow} onClick={toggleExpanded}>
          {isExpanded ? 
            <ArrowUpIcon className={styles.arrowIcon} /> : 
            <ArrowDownIcon className={styles.arrowIcon} />
          }
        </div>
      )}
      
      {/* 历史记录弹窗 */}
      <HistoryRecords
        ref={historyRecordsRef}
        onSelectPrompt={handleSelectHistoryPrompt}
      />
    </div>
  );
};

export default InputStatusSection;
