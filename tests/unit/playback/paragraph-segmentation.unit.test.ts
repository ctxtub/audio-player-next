import assert from 'node:assert';
import {
    normalizeStoryText,
    segmentStoryText,
    computeStoryContentHash,
} from '../../../utils/segmentation';

/**
 * 段落切分纯函数单元测试（任务11 STEP-3，L1）。
 * 来源：tests/legacy/paragraph-resume-mixed.legacy.test.ts 中 §0 纯函数部分逐字承接。
 * 拆分：本文件仅收容确定性切分/归一/哈希/预取公式（0.1-0.5），无 DB/网络/store；
 * 跨 store/service 部分（TC-P2-01~17）已拆至
 * tests/integration/playback/paragraph-resume-mixed.integration.test.ts。
 * 断言语义不变（向量保持）。
 */

/** 执行确定性切分与指纹断言。 */
async function runParagraphSegmentationTests(): Promise<void> {
    console.log('=== 0. Testing Deterministic Segmentation, Normalization & Fingerprints ===');

    // 0.1 Normalization of CRLF and trailing whitespace
    const rawText = "第一段故事。\r\n第二段故事。   \r\n第三段故事。  ";
    const normalized = normalizeStoryText(rawText);
    assert.strictEqual(normalized, "第一段故事。\n第二段故事。\n第三段故事。");

    // 0.2 Long paragraph split (> 350 chars)
    const longSentence = "这是一个很长很长的句子，充满了各种细节和波折。".repeat(20);
    assert(longSentence.length > 350, "Sentence should be longer than 350 characters");
    const splitChunks = segmentStoryText(longSentence);
    assert(splitChunks.length >= 2, "Long paragraph must be split into multiple chunks");
    for (const chunk of splitChunks) {
        assert(chunk.length <= 350, `Chunk length ${chunk.length} must not exceed 350`);
    }

    // 0.3 Short dialogue forward merge (< 80 chars)
    const shortDialogues = "“你好！”\n“你也好。”\n“今天天气真好啊。”\n“确实很晴朗。”\n这是一段稍微长一点的描述文字，用于承接刚才几句短小的对话。";
    const mergedChunks = segmentStoryText(shortDialogues);
    assert(mergedChunks.length < 5, "Short dialogues must be merged to prevent micro audio fragments");

    // 0.4 Deterministic ContentHash (12 hex characters)
    const hash1 = computeStoryContentHash("故事正文内容ABC");
    const hash2 = computeStoryContentHash("故事正文内容ABC\r\n"); // normalizes to same text
    assert.strictEqual(hash1.length, 12, "Hash must be 12 hex characters");
    assert.strictEqual(hash1, "dcd35acfdfde", "Hash must match exact regression vector dcd35acfdfde");
    assert.strictEqual(hash1, hash2, "Normalized text must yield identical hash regardless of CRLF");

    // 0.5 Adaptive prefetch window formula
    const calcPrefetchThreshold = (duration: number) => Math.min(10, Math.max(5, duration * 0.25));
    assert.strictEqual(calcPrefetchThreshold(40), 10);
    assert.strictEqual(calcPrefetchThreshold(20), 5);
    assert.strictEqual(calcPrefetchThreshold(60), 10);
    assert.strictEqual(calcPrefetchThreshold(12), 5);

    console.log('PASS: Segmentation, normalization, content hash and adaptive prefetch verified');
    console.log('\nALL PARAGRAPH SEGMENTATION TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runParagraphSegmentationTests()
    .then(() => {
        console.log('ALL PARAGRAPH SEGMENTATION TEST CASES PASSED SUCCESSFULLY!');
    })
    .catch((err) => {
        console.error('Test execution failed:', err);
        process.exit(1);
    });

export default testPromise;
