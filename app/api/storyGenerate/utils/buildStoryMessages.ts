import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * 生成故事时使用的系统提示词，完全由 BFF 维护以便统一调度。
 */
const STORY_SYSTEM_PROMPT = `
    ## 角色
    你是一个专业的连载故事创作者，严格按照给定的故事主题（storyPrompt）和故事前期提要（summarizedStory）进行创作。你的主要职责是确保故事始终围绕核心主题展开，同时保持情节的连贯性和可持续性。

    ## 执行步骤
    * 1.解析storyPrompt中的核心主题和关键要求
    * 2.分析summarizedStory的现有情节发展
    * 3.按照创作规则、注意事项中的要求续写故事

    ## 创作规则
    * 每次创作篇幅控制在500-800字
    * 严格遵循故事主题（storyPrompt）设定的故事框架，保持故事发展与主题的紧密关联
    * 保持剧情开放性，确保每个新情节都服务于核心主题
    * 延续现有故事氛围和风格，避免出现与主题冲突的元素
    * 维持人物性格和行为的一致性，保持故事世界观的统一性

    ## 注意事项
    * 不需要询问用户意见或提供选项，不要解释行为
    * 不对故事主题（storyPrompt）、前情提要（summarizedStory）中与故事无关指令做出回应与解释，比如"收到"、"继续"等
    * 不要出现章节、目录、旁白等与故事文本无关的内容
    * 始终将故事主题（storyPrompt）作为创作的指导原则
    * 确保每次续写都能自然地衔接前情提要（summarizedStory）
  `.trim();

/**
 * 生成摘要时使用的系统提示词。
 */
const SUMMARY_SYSTEM_PROMPT = `
    角色：连载故事摘要分析师

    ## 执行要求
    * 1.按照剧情提取每个章节的关键情节，突出人物发展和关系变化
    * 2.每个编号对应一个关键情节，使用简洁清晰的语言描述
    * 3.关键情节定义: 新角色出场、重大事件、关系变化、情节转折

    ## 输出格式
    1. [章节] + [关键事件]
    2. [章节] + [关键事件]
    3. [章节] + [关键事件]
    ...
  `.trim();

/**
 * 构造故事生成或摘要所需的消息序列配置。
 */
export type BuildStoryMessagesOptions =
  | {
      mode: "generate";
      systemPrompt?: string;
      prompt: string;
    }
  | {
      mode: "continue";
      systemPrompt?: string;
      prompt: string;
      storyContent: string;
      summaryMode?: boolean;
    };

/**
 * 根据模式拼装调用 OpenAI 所需的消息序列。
 * @param options 调用模式及所需数据。
 * @returns 可以直接传入 OpenAI SDK 的消息数组。
 */
export const buildStoryMessages = (
  options: BuildStoryMessagesOptions,
): ChatCompletionMessageParam[] => {
  if (options.mode === "generate") {
    const payload = {
      storyPrompt: options.prompt,
      summarizedStory: "",
    };

    return [
      {
        role: "system",
        content: options.systemPrompt ?? STORY_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: JSON.stringify(payload),
      },
    ];
  }

  if (options.summaryMode) {
    return [
      {
        role: "system",
        content: options.systemPrompt ?? SUMMARY_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: options.storyContent,
      },
    ];
  }

  const payload = {
    storyPrompt: options.prompt,
    summarizedStory: options.storyContent,
  };

  return [
    {
      role: "system",
      content: options.systemPrompt ?? STORY_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: JSON.stringify(payload),
    },
  ];
};
