import React, { useState, useEffect, useRef } from 'react';
import { Toast } from 'antd-mobile';
import HistoryRecords, { HistoryRecordsRef } from '@/app/home/components/HistoryRecords';
import {
  usePromptHistoryStore,
  selectIsInitialized,
} from '@/stores/promptHistoryStore';

/**
 * 输入与状态模块的入参定义。
 */

interface InputStatusSectionProps {
  // StoryInput props
  inputText: string;
  handleSubmit: (text: string) => Promise<void>;
}

/**
 * 首页输入与状态模块，负责发起故事生成并聚合输入操作。
 */
const InputStatusSection: React.FC<InputStatusSectionProps> = ({
  // StoryInput props
  inputText,
  handleSubmit,
}) => {
  // 接口请求中的状态锁，true 表示阻塞新的请求。
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [textareaInput, setTextareaInput] = useState('');
  const historyRecordsRef = useRef<HistoryRecordsRef>(null);
  const hydrateHistory = usePromptHistoryStore((state) => state.hydrate);
  const addHistoryRecord = usePromptHistoryStore((state) => state.addOrUpdate);
  const isHistoryInitialized = usePromptHistoryStore(selectIsInitialized);

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

  useEffect(() => {
    if (!isHistoryInitialized) {
      hydrateHistory();
    }
  }, [hydrateHistory, isHistoryInitialized]);

  // 处理快捷按钮点击
  const handleQuickSelect = (content: string) => {
    if (isSubmitting) {
      return;
    }
    handleSubmitWithHistory(content);
  };

  // 从历史记录中选择提示词
  const handleSelectHistoryPrompt = (prompt: string) => {
    if (isSubmitting) {
      return;
    }
    handleSubmitWithHistory(prompt);
  };
  
  // 处理input提交
  const onSubmit = () => {
    if (isSubmitting) {
      return;
    }
    if (!textareaInput || textareaInput.trim() === '') {
      Toast.show({ icon: 'fail', content: '请输入故事概要，再生成故事哦~' });
      return;
    }
    handleSubmitWithHistory(textareaInput);
  };

  // 包装 handleSubmit 以添加历史记录功能，同时在请求过程中加锁。
  const handleSubmitWithHistory = async (text: string) => {
    if (isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    // 保存提示词到历史记录
    addHistoryRecord(text);
    try {
      // 调用父组件的 handleSubmit
      await handleSubmit(text);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleHistoryButtonClick = () => {
    historyRecordsRef.current?.showModal();
  };

  return (
    <div className="mb-[10px] flex flex-col gap-3 overflow-hidden rounded-2xl bg-[var(--card-background)] p-[15px] shadow-[0_8px_16px_var(--shadow-color)] backdrop-blur-[var(--blur-radius)] transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)]">
      <div className="flex max-h-[300px] flex-col gap-1 transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)]">
        <div className="mb-[10px] grid grid-cols-3 gap-[10px]">
          {storyTypes.map((type, index) => (
            <button
              key={index}
              className="overflow-hidden text-ellipsis whitespace-nowrap rounded-[10px] border border-transparent bg-[color-mix(in_srgb,var(--primary)_5%,transparent)] px-2 py-3 text-sm font-medium text-[var(--foreground)] shadow-[0_2px_8px_rgba(0,0,0,0.03)] transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)] enabled:hover:-translate-y-[2px] enabled:hover:bg-[color-mix(in_srgb,var(--primary)_15%,transparent)] enabled:hover:shadow-[0_4px_8px_color-mix(in_srgb,var(--primary)_10%,transparent)] enabled:active:translate-y-0 enabled:active:bg-[color-mix(in_srgb,var(--primary)_20%,transparent)] enabled:active:shadow-[0_2px_4px_color-mix(in_srgb,var(--primary)_10%,transparent)] disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => handleQuickSelect(type.content)}
              disabled={isSubmitting}
              title={type.content}
            >
              {type.label}
            </button>
          ))}
          <button
            className="overflow-hidden text-ellipsis whitespace-nowrap rounded-[10px] border border-dashed border-[color-mix(in_srgb,var(--process)_30%,transparent)] bg-[color-mix(in_srgb,var(--process)_10%,transparent)] px-2 py-3 text-sm font-semibold text-[var(--foreground)] shadow-[0_2px_8px_rgba(0,0,0,0.03)] transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)] enabled:hover:-translate-y-[2px] enabled:hover:bg-[color-mix(in_srgb,var(--process)_20%,transparent)] enabled:hover:shadow-[0_4px_8px_color-mix(in_srgb,var(--process)_15%,transparent)] enabled:active:translate-y-0 enabled:active:bg-[color-mix(in_srgb,var(--process)_25%,transparent)] enabled:active:shadow-[0_2px_4px_color-mix(in_srgb,var(--process)_15%,transparent)] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handleHistoryButtonClick}
            disabled={isSubmitting}
            title="查看历史提示词记录"
          >
            历史记录
          </button>
        </div>
        <div className="flex w-full items-stretch rounded-[12px] shadow-[0_2px_8px_rgba(0,0,0,0.03)]">
          <textarea
            value={textareaInput}
            onChange={(e) => setTextareaInput(e.target.value)}
            placeholder="输入你想听的故事概要..."
            rows={2}
            className="min-h-[60px] flex-1 resize-y rounded-l-[12px] rounded-r-none border-0 bg-[color-mix(in_srgb,var(--inputBackground)_80%,transparent)] px-5 py-[15px] text-sm text-[var(--foreground)] transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)] placeholder:text-[var(--secondary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--primary)_30%,transparent)] focus:ring-offset-0 focus:bg-[var(--inputBackground)] disabled:cursor-not-allowed disabled:opacity-70"
            disabled={isSubmitting}
          />
          <button
            className="relative ml-[-1px] flex min-w-[120px] items-center justify-center gap-2 rounded-r-[12px] border-0 bg-[color-mix(in_srgb,var(--primary)_5%,transparent)] px-4 py-[15px] text-sm font-semibold text-[var(--foreground)] transition-transform duration-[var(--transition-speed)] ease-[var(--transition-timing)] enabled:hover:-translate-y-[2px] enabled:hover:bg-[color-mix(in_srgb,var(--primary)_15%,transparent)] enabled:hover:shadow-[0_4px_8px_color-mix(in_srgb,var(--primary)_10%,transparent)] enabled:active:translate-y-0 enabled:active:bg-[color-mix(in_srgb,var(--primary)_20%,transparent)] enabled:active:shadow-[0_2px_4px_color-mix(in_srgb,var(--primary)_10%,transparent)] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onSubmit}
            disabled={isSubmitting}
          >
            {isSubmitting ? '生成中...' : '生成故事'}
          </button>
        </div>
    </div>

    {/* 历史记录弹窗 */}
    <HistoryRecords
      ref={historyRecordsRef}
      onSelectPrompt={handleSelectHistoryPrompt}
      />
    </div>
  );
};

export default InputStatusSection;
