/**
 * 意图识别工具
 *
 * 检测用户输入是否表达了故事生成意图，用于在聊天页面决定调用普通对话流还是故事生成流。
 */

/** 故事请求的关键词列表，匹配到任一关键词即视为故事请求。 */
const STORY_KEYWORDS = [
    '讲',
    '来一段',
    '听',
    '编',
    '创作',
    '说',
    '念',
    '故事',
    '续写',
    '继续',
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
