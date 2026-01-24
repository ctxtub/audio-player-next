/**
 * 意图识别工具
 *
 * 检测用户输入是否表达了故事生成意图，用于在聊天页面决定调用普通对话流还是故事生成流。
 */

/** 故事请求的关键词列表，匹配到任一关键词即视为故事请求。 */
const STORY_KEYWORDS = [
    '讲一个',
    '来一段',
    '生成故事',
    '我想听',
    '给我讲',
    '编一个',
    '创作一个',
    '睡前故事',
    '讲个故事',
    '来个故事',
    '说一个',
    '念一个',
];

/**
 * 检测用户输入是否表达了故事生成意图。
 * @param input 用户输入文本
 * @returns true 表示识别为故事请求，应触发故事生成流程
 */
export const detectStoryIntent = (input: string): boolean => {
    const normalized = input.trim();
    return STORY_KEYWORDS.some((kw) => normalized.includes(kw));
};
