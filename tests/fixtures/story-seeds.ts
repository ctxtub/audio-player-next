import { SEGMENTATION_VERSION } from '../../utils/segmentation';

/**
 * 段落断点恢复场景的合成故事种子（与 `{{E2E_STORY_4P}}` 同构的 4 段固定文本）。
 *
 * 来源：原 `tests/test-paragraph-resume.ts` TC-P2-01 内联种子逐字迁移；
 * 用途：断点恢复/水合/漂移检测等段落级用例的统一故事底本。
 */
export const SQUIRREL_STORY_PARAGRAPHS: readonly string[] = [
    '第一自然段：很久很久以前，在宁静的大森林深处住着一只聪明活泼的小松鼠，它有一条蓬松的大尾巴，每天清晨都在高高的树梢间欢快地跳来跳去，寻找新鲜的坚果与甘甜的露水。',
    '第二自然段：小松鼠每天早晨迎着金色的朝阳出门收集松果，仔细辨别每一颗果实是否饱满香甜，并将它们整齐地存放在自己温暖干燥的树洞深处，准备迎接即将到来的寒冷冬天。',
    '第三自然段：有一天它在一棵巨大的古老松树下发现了一颗闪闪发光的神奇松果，散发出奇异而温暖的柔和光芒，不仅照亮了周围湿漉漉的青苔，还散发出一种让人心情平静的香气。',
    '第四自然段：这颗发光的松果带领着好奇的小松鼠走进了森林最深处的奇妙花园，那里盛开着从未见过的美丽奇幻花朵，彩色的蝴蝶在花丛中翩翩起舞，宛如梦境一般美丽动人。',
];

/**
 * 种子故事标题（合成，与段落一一对应）。
 */
export const SQUIRREL_STORY_TITLE = '小松鼠的故事';

/**
 * 拼接种子故事全文（段落间单换行分隔，与入库 `content` 形态一致）。
 * @returns 故事全文
 */
export function buildSquirrelStoryText(): string {
    // 中文注释：单 `\n` 分隔即 `normalizeStoryText` 规范形。
    return SQUIRREL_STORY_PARAGRAPHS.join('\n');
}

/**
 * 故事卡聊天消息形态（入库 `saveConversationForSubject` 与 store 水合共用）。
 */
export interface StoryChatMessageSeed {
    messageId: string;
    role: 'assistant';
    content: string;
    parts: Array<{ type: 'storyCard'; storyText: string; audioUrl: string }>;
}

/**
 * 构造故事卡聊天消息种子（`audioUrl` 置空，落库 Sanitizer 语义一致）。
 * @param messageId 合成消息 ID
 * @param storyText 故事全文
 * @returns 聊天消息种子
 */
export function buildStoryChatMessage(messageId: string, storyText: string): StoryChatMessageSeed {
    // 中文注释：audioUrl 置空——blob 地址永不入库。
    return {
        messageId,
        role: 'assistant',
        content: storyText,
        parts: [{ type: 'storyCard', storyText, audioUrl: '' }],
    };
}

/**
 * 段落进度 `saveProgress` 输入种子（停在第 3 段开头，`nextParagraphIndex=2`）。
 */
export interface ParagraphProgressSeed {
    sourceType: 'chat';
    sourceId: string;
    title: string;
    contentHash: string;
    segmentationVersion: string;
    lastCompletedParagraphIndex: number;
    nextParagraphIndex: number;
    totalParagraphs: number;
    voiceId: string;
    speed: number;
}

/**
 * 构造段落进度输入种子（TC-P2-01 范式：完成第 2 段，断点第 3 段）。
 * @param sourceId 合成消息 ID（即 sourceId）
 * @param contentHash 故事正文哈希（调用方经 `computeStoryContentHash` 计算）
 * @returns 进度输入种子
 */
export function buildParagraphProgressSeed(sourceId: string, contentHash: string): ParagraphProgressSeed {
    // 中文注释：contentHash 由调用方计算，保持哈希口径单一来源。
    return {
        sourceType: 'chat',
        sourceId,
        title: SQUIRREL_STORY_TITLE,
        contentHash,
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: 1,
        nextParagraphIndex: 2,
        totalParagraphs: 4,
        voiceId: 'alloy',
        speed: 1.0,
    };
}

/**
 * 种子故事配套的内容哈希载荷（`buildParagraphProgressSeed` 的 contentHash 入参来源说明）。
 */
export const PARAGRAPH_PROGRESS_SEED_HASH_NOTE =
    'contentHash 须由调用方对 buildSquirrelStoryText() 结果执行 computeStoryContentHash 得出，不得硬编码。';
