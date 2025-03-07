import { APIConfig } from '@/types/types';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface StoryPrompt {
  storyPrompt: string;
  summarizedStory: string;
}

export const generateStory = async (prompt: string, config: APIConfig): Promise<string> => {
  try {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: getSystemPrompt()
      },
      {
        role: 'user',
        content: JSON.stringify({
          storyPrompt: prompt,
          summarizedStory: ''
        } as StoryPrompt)
      }
    ];

    const response = await fetch(`${config.apiBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.storyModel,
        messages,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`API请求失败: ${errorData.error?.message || response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    throw new Error(`生成故事失败: ${error instanceof Error ? error.message : '未知错误'}`);
  }
};

export const continueStory = async (
  originalPrompt: string,
  storyContent: string,
  config: APIConfig
): Promise<string> => {
  try {
    const summarizedStory = config.summaryModel 
      ? await summarizeStory(storyContent, config) 
      : storyContent;

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: getSystemPrompt()
      },
      {
        role: 'user',
        content: JSON.stringify({
          storyPrompt: originalPrompt,
          summarizedStory: summarizedStory
        } as StoryPrompt)
      }
    ];

    const response = await fetch(`${config.apiBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.storyModel,
        messages,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`API请求失败: ${errorData.error?.message || response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    throw new Error(`续写故事失败: ${error instanceof Error ? error.message : '未知错误'}`);
  }
};

export const fetchAudio = async (text: string, config: APIConfig): Promise<string> => {
  try {
    // Azure TTS 使用单独的接口
    if (config.voiceProvider === 'azure-tts') {
      return await fetchAzureAudio(text, config);
    }

    // Free TTS 接口
    const response = await fetch(`${config.apiBaseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.freeTtsConfig.speechKey}`
      },
      body: JSON.stringify({
        model: 'free-tts',
        input: text,
        voice: config.freeTtsConfig.voiceName
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || `请求失败: ${response.status}`);
    }

    const audioBlob = await response.blob();
    return URL.createObjectURL(audioBlob);
  } catch (error) {
    throw error;
  }
};

const fetchAzureAudio = async (text: string, config: APIConfig): Promise<string> => {
  if (!config.azureTtsConfig) {
    throw new Error('Azure配置缺失');
  }

  const { speechKey, speechRegion, voiceName } = config.azureTtsConfig;
  
  const ssml = `
    <speak version='1.0' xml:lang='zh-CN'>
      <voice xml:lang='zh-CN' name='${voiceName}'>
        ${text}
      </voice>
    </speak>
  `;

  try {
    const response = await fetch(
      `https://${speechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': speechKey,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
          'User-Agent': 'YourApp'
        },
        body: ssml
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure TTS API请求失败: ${response.status} - ${errorText}`);
    }

    const audioBlob = await response.blob();
    return URL.createObjectURL(audioBlob);
  } catch (error) {
    throw new Error(`Azure TTS调用失败: ${error instanceof Error ? error.message : '未知错误'}`);
  }
};

function getSystemPrompt(): string {
  return `
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
   `;
}

async function summarizeStory(story: string, config: APIConfig): Promise<string> {
  try {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `
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
        `
      },
      {
        role: 'user',
        content: story
      }
    ];

    const response = await fetch(`${config.apiBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.summaryModel,
        messages,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`${errorData.error?.message || response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    throw new Error(`故事缩略失败: ${error instanceof Error ? error.message : '未知错误'}`);
  }
}
