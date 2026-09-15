import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  COLLECTION_TITLE_FALLBACK,
  COLLECTION_TITLE_MAX_LENGTH,
  CONVERSATION_ID_RE,
} from '../../../lib/storyCollection/constants';
import {
  LEGACY_HISTORY_READS_ENABLED_ENV,
  LEGACY_HISTORY_WRITE_ENABLED_ENV,
  STORY_COLLECTION_READS_ENABLED_ENV,
  isLegacyHistoryReadsEnabled,
  isLegacyHistoryWriteEnabled,
  isStoryCollectionReadsEnabled,
  resolveStoryCollectionRollout,
} from '../../../lib/storyCollection/rollout';
import {
  buildCollectionFallbackTitle,
  normalizeCollectionTitle,
  resolveExistingCollectionTitle,
  resolveFirstCollectionTitle,
  strictStoryTitle,
} from '../../../lib/storyCollection/title';
import {
  buildCollectionCursorPredicate,
  decodeCollectionCursor,
  encodeCollectionCursor,
  isCollectionCursorMatchingInput,
} from '../../../lib/storyCollection/cursor';
import {
  createCollectionId,
  deriveDeterministicId,
} from '../../../lib/storyCollection/identity';
import {
  collectionListInputSchema,
  collectionPromoteInputSchema,
  collectionSummaryDtoSchema,
} from '../../../lib/trpc/schemas/collection';
import { LIBRARY_PAGE_DEFAULT_LIMIT, LIBRARY_PAGE_MAX_LIMIT } from '../../../lib/storyWork/constants';

/**
 * M9-C1 StoryCollection 领域契约单元测试（L1，无 DB）。
 *
 * 覆盖：标题规范化与回退链、严格正文标题、已有集合标题收敛、幂等身份派生、
 * keyset 游标编解码与视图绑定、列表/摘要/promotion 入参 Schema。
 */
async function runCollectionDomainUnitTests() {
  console.log('=== 1. normalizeCollectionTitle 规范化与截断 ===');
  {
    assert.strictEqual(normalizeCollectionTitle('  你好   世界  '), '你好 世界');
    assert.strictEqual(normalizeCollectionTitle('“引号标题”'), '引号标题');
    assert.strictEqual(normalizeCollectionTitle(''), '');
    assert.strictEqual(normalizeCollectionTitle(null), '');
    const long = 'a'.repeat(COLLECTION_TITLE_MAX_LENGTH + 10);
    const truncated = normalizeCollectionTitle(long);
    assert.strictEqual([...truncated].length, COLLECTION_TITLE_MAX_LENGTH, '截断后须为 80 code points');
    assert.ok(truncated.endsWith('…'), '超长标题截断须以 … 结尾');
    console.log('PASS: 1');
  }

  console.log('=== 2. strictStoryTitle 只认显式标题格式 ===');
  {
    assert.strictEqual(strictStoryTitle('# 夜行记\n\n正文开始'), '夜行记');
    assert.strictEqual(strictStoryTitle('《夜行记》\n正文'), '夜行记');
    assert.strictEqual(strictStoryTitle('【夜行记】\n正文'), '夜行记');
    assert.strictEqual(strictStoryTitle('这是一个普通的开头。'), null, '普通首句绝不猜测为标题');
    assert.strictEqual(strictStoryTitle(''), null);
    assert.strictEqual(strictStoryTitle(null), null);
    console.log('PASS: 2');
  }

  console.log('=== 3. 确定性回退链：正文标题 → prompt → 未命名作品集 ===');
  {
    assert.deepStrictEqual(
      buildCollectionFallbackTitle({ storyText: '# 标题甲', prompt: '提示词' }),
      { title: '标题甲', titleSource: 'fallback' },
    );
    assert.deepStrictEqual(
      buildCollectionFallbackTitle({ prompt: '一个关于秋天的提示词' }),
      { title: '一个关于秋天的提示词', titleSource: 'fallback' },
    );
    assert.deepStrictEqual(buildCollectionFallbackTitle({}), {
      title: COLLECTION_TITLE_FALLBACK,
      titleSource: 'fallback',
    });
    assert.deepStrictEqual(buildCollectionFallbackTitle({ storyText: '   ', prompt: '   ' }), {
      title: COLLECTION_TITLE_FALLBACK,
      titleSource: 'fallback',
    });
    const longPrompt = buildCollectionFallbackTitle({ prompt: '提'.repeat(120) });
    assert.ok([...longPrompt.title].length <= 32, 'prompt 回退标题须截断至 32 code points');
    console.log('PASS: 3');
  }

  console.log('=== 4. resolveFirstCollectionTitle：AI 优先且空值回退 ===');
  {
    assert.deepStrictEqual(
      resolveFirstCollectionTitle({ aiTitle: '  AI 标题  ', storyText: '# 正文标题', prompt: 'p' }),
      { title: 'AI 标题', titleSource: 'ai' },
    );
    assert.deepStrictEqual(resolveFirstCollectionTitle({ aiTitle: '   ', prompt: '回退提示' }), {
      title: '回退提示',
      titleSource: 'fallback',
    });
    assert.deepStrictEqual(resolveFirstCollectionTitle({ aiTitle: null }), {
      title: COLLECTION_TITLE_FALLBACK,
      titleSource: 'fallback',
    });
    console.log('PASS: 4');
  }

  console.log('=== 5. resolveExistingCollectionTitle：用户标题永不覆盖 ===');
  {
    assert.deepStrictEqual(
      resolveExistingCollectionTitle({
        existingTitle: '用户命名',
        existingTitleSource: 'user',
        prompt: '新提示',
      }),
      { title: '用户命名', titleSource: 'user' },
    );
    assert.deepStrictEqual(
      resolveExistingCollectionTitle({
        existingTitle: 'AI 命名',
        existingTitleSource: 'ai',
        prompt: '新提示',
      }),
      { title: 'AI 命名', titleSource: 'ai' },
    );
    assert.deepStrictEqual(
      resolveExistingCollectionTitle({
        existingTitle: '',
        existingTitleSource: 'fallback',
        storyText: '# 首作标题',
      }),
      { title: '首作标题', titleSource: 'fallback' },
    );
    console.log('PASS: 5');
  }

  console.log('=== 6. 确定性身份派生（可重复且 UUID v5 形态）===');
  {
    const a = deriveDeterministicId('ns', 'user:1:work:9');
    const b = deriveDeterministicId('ns', 'user:1:work:9');
    assert.strictEqual(a, b, '同输入恒得同 id');
    assert.ok(CONVERSATION_ID_RE.test(a), `确定性 id 须为 UUID 形态：${a}`);
    assert.strictEqual(a[14], '5', '版本位须为 5');
    assert.ok('89ab'.includes(a[19]), '变体位须为 8/9/a/b');
    assert.notStrictEqual(deriveDeterministicId('ns', 'user:1:work:10'), a);
    assert.notStrictEqual(deriveDeterministicId('ns2', 'user:1:work:9'), a);
    assert.ok(CONVERSATION_ID_RE.test(createCollectionId()), '随机集合 id 须为 UUID 形态');
    console.log('PASS: 6');
  }

  console.log('=== 7. 集合 keyset 游标编解码与视图绑定 ===');
  {
    const id = '11111111-1111-4111-8111-111111111111';
    const cursor = encodeCollectionCursor({
      view: 'active',
      query: '秋',
      t: '2026-01-01T00:00:00.000Z',
      id,
    });
    const decoded = decodeCollectionCursor(cursor);
    assert.ok(decoded, '合法游标须可解码');
    assert.strictEqual(decoded!.view, 'active');
    assert.strictEqual(decoded!.id, id);
    assert.strictEqual(isCollectionCursorMatchingInput(decoded!, { view: 'active', query: '秋' }), true);
    assert.strictEqual(isCollectionCursorMatchingInput(decoded!, { view: 'trash', query: '秋' }), false, '跨视图须拒绝');
    assert.strictEqual(isCollectionCursorMatchingInput(decoded!, { view: 'active', query: '冬' }), false, '跨搜索指纹须拒绝');
    assert.strictEqual(decodeCollectionCursor('!!!not-a-cursor!!!'), null);
    const wrongVersion = Buffer.from(
      JSON.stringify({ v: 999, view: 'active', q: '', t: '2026-01-01T00:00:00.000Z', id }),
      'utf-8',
    ).toString('base64url');
    assert.strictEqual(decodeCollectionCursor(wrongVersion), null, '错误版本号须拒绝');
    const activePredicate = buildCollectionCursorPredicate(decoded!);
    assert.ok('createdAt' in (activePredicate.OR[0] as Record<string, unknown>), 'active 游标用 createdAt');
    const trashCursor = decodeCollectionCursor(
      encodeCollectionCursor({ view: 'trash', t: '2026-01-01T00:00:00.000Z', id }),
    )!;
    const trashPredicate = buildCollectionCursorPredicate(trashCursor);
    assert.ok('deletedAt' in (trashPredicate.OR[0] as Record<string, unknown>), 'trash 游标用 deletedAt');
    console.log('PASS: 7');
  }

  console.log('=== 8. 列表 / 摘要 / promotion Schema 边界 ===');
  {
    const defaults = collectionListInputSchema.parse({});
    assert.strictEqual(defaults.view, 'active');
    assert.strictEqual(defaults.limit, LIBRARY_PAGE_DEFAULT_LIMIT);
    assert.strictEqual(defaults.query, undefined);
    assert.strictEqual(collectionListInputSchema.safeParse({ limit: LIBRARY_PAGE_MAX_LIMIT + 1 }).success, false);
    assert.strictEqual(collectionListInputSchema.safeParse({ view: 'bogus' }).success, false);

    const summary = collectionSummaryDtoSchema.safeParse({
      id: 'c1',
      title: '标题',
      titleSource: 'ai',
      workCount: 0,
      favoritedAt: null,
      deletedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    assert.strictEqual(summary.success, true);
    assert.strictEqual(
      collectionSummaryDtoSchema.safeParse({
        id: 'c1',
        title: '标题',
        titleSource: 'bogus',
        workCount: 0,
        favoritedAt: null,
        deletedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }).success,
      false,
      '非法 titleSource 须拒绝',
    );

    const promote = collectionPromoteInputSchema.parse({
      conversationId: 'c1',
      sourceMessageId: 'm1',
      prompt: '提示词',
      storyText: '故事正文',
    });
    assert.strictEqual(promote.conversationId, 'c1');
    assert.strictEqual(promote.voiceId ?? null, null);
    assert.strictEqual(
      collectionPromoteInputSchema.safeParse({ conversationId: 'c1', sourceMessageId: 'm1', prompt: '', storyText: '正文' }).success,
      false,
      '空 prompt 须拒绝',
    );
    console.log('PASS: 8');
  }

  console.log('=== 9. 回退开关默认值与显式关闭 ===');
  {
    assert.deepStrictEqual(resolveStoryCollectionRollout({}), {
      storyCollectionReads: true,
      legacyHistoryReads: true,
      legacyHistoryWrites: true,
    });
    assert.strictEqual(
      isStoryCollectionReadsEnabled({ [STORY_COLLECTION_READS_ENABLED_ENV]: 'false' }),
      false,
    );
    assert.strictEqual(
      isLegacyHistoryReadsEnabled({ [LEGACY_HISTORY_READS_ENABLED_ENV]: '0' }),
      false,
    );
    assert.strictEqual(
      isLegacyHistoryWriteEnabled({ [LEGACY_HISTORY_WRITE_ENABLED_ENV]: 'false' }),
      false,
    );
    console.log('PASS: 9');
  }

  console.log('=== 10. 新路径结构性零 Prompt/Generation History 写入（静态守卫）===');
  {
    const newPathFiles = [
      'lib/server/storyCollection.ts',
      'lib/server/conversation.ts',
      'lib/server/collectionTitle.ts',
      'lib/client/collection.ts',
      'lib/client/conversation.ts',
      'lib/trpc/routers/collection.ts',
      'lib/trpc/routers/conversation.ts',
    ];
    const forbidden = [
      /recordPromptHistoryForSubject/,
      /recordGenerationHistoryForSubject/,
      /from\s+['"][^'"]*server\/promptHistory[^'"]*['"]/,
      /from\s+['"][^'"]*server\/generationHistory[^'"]*['"]/,
      /prisma\s*\.\s*promptHistory/,
      /prisma\s*\.\s*generationHistory/,
      /prisma\s*\.\s*guestPromptHistory/,
      /prisma\s*\.\s*guestGenerationHistory/,
      /promptHistoryRouter/,
      /generationHistoryRouter/,
    ];
    for (const rel of newPathFiles) {
      const source = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
      for (const re of forbidden) {
        assert.strictEqual(
          re.test(source),
          false,
          `${rel} 新路径不得写入旧 History：${String(re)}`,
        );
      }
    }
    console.log('PASS: 10');
  }

  console.log('ALL COLLECTION DOMAIN UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = runCollectionDomainUnitTests()
  .then(() => {
    console.log('ALL COLLECTION DOMAIN UNIT TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
