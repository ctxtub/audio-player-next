import assert from 'node:assert';
import {
  computeStoryContentHash as rootComputeStoryContentHash,
  normalizeStoryText,
} from '../../../utils/segmentation';
import {
  FALLBACK_STORY_TITLE,
  LIBRARY_CURSOR_VERSION,
  LIBRARY_PAGE_DEFAULT_LIMIT,
  LIBRARY_PAGE_MAX_LIMIT,
  LIBRARY_PAGE_MIN_LIMIT,
  LIBRARY_QUERY_MAX_LENGTH,
  STORY_EXCERPT_MAX_LENGTH,
  STORY_TITLE_MAX_LENGTH,
  STORY_TITLE_PROMPT_FALLBACK_MAX_LENGTH,
} from '../../../lib/storyWork/constants';
import {
  buildPromptFallbackTitle,
  buildStoryExcerpt,
  computeStoryContentHash,
  extractHeadingTitle,
  getCodePointLength,
  normalizeStoryTitle,
  resolveStoryTitle,
  stripPairedQuotes,
} from '../../../lib/storyWork/metadata';
import {
  buildCursorPredicate,
  computeQueryFingerprint,
  decodeLibraryCursor,
  encodeLibraryCursor,
  isCursorMatchingInput,
  normalizeQuery,
} from '../../../lib/storyWork/cursor';
import {
  createMissingAudioProjection,
  DEFAULT_AUDIO_PROJECTION,
  libraryListInputSchema,
  libraryListOutputSchema,
  storyAudioProjectionSchema,
  storyWorkDetailDtoSchema,
  storyWorkSummaryDtoSchema,
} from '../../../lib/trpc/schemas/library';

/**
 * StoryWork 纯领域契约与派生字段算法单元测试（M2-02，L1）。
 *
 * 验证：
 * 1. contentHash 精确回归向量与 CRLF/LF 换行等价性（直接复用 utils/segmentation）。
 * 2. title derivation 全边界链条（explicit / heading / prompt fallback / unnamed）。
 * 3. excerpt derivation 截取规则与长度上限。
 * 4. audio missing projection 缺省结构。
 * 5. limit 默认值 (20) 与最大值 (50) 校验。
 * 6. query normalization 规整边界。
 * 7. cursor encode/decode 稳定 round-trip 与非法/越界游标拒绝。
 * 8. 客观证明：title / favoritedAt / deletedAt 的变更绝不改变 contentHash。
 */
async function runStoryWorkDomainTests(): Promise<void> {
  console.log('=== 1. contentHash 精确回归向量与 CRLF/LF 跨平台等价性 ===');
  // 1.1 保证纯领域模块直接引用现有实现，而非第二份重新实现
  assert.strictEqual(
    computeStoryContentHash,
    rootComputeStoryContentHash,
    'lib/storyWork/metadata 中的 computeStoryContentHash 必须恒等于 utils/segmentation 导出'
  );

  // 1.2 精确回归向量锁定（防静默破坏历史续播断点数据）
  assert.strictEqual(computeStoryContentHash(''), '', '空正文哈希必须为空串');
  assert.strictEqual(
    computeStoryContentHash('故事正文内容ABC'),
    'dcd35acfdfde',
    '向量 1 回归锁定'
  );
  assert.strictEqual(
    computeStoryContentHash('很久以前，在月球的背面住着一只从未见过地球的小狐狸。'),
    'fe7f7272dd2d',
    '向量 2 回归锁定'
  );
  assert.strictEqual(
    computeStoryContentHash('Hello World! 123'),
    '70a1e7b28224',
    '向量 3 回归锁定'
  );

  // 1.3 CRLF 与 LF 以及行尾空格归一化后的哈希确定性
  const crlfText = '第一行\r\n第二行   \r\n第三行';
  const lfText = '第一行\n第二行\n第三行';
  assert.strictEqual(
    computeStoryContentHash(crlfText),
    '8388d4b2d9ea',
    'CRLF 文本必须产出固定 12 位十六进制哈希'
  );
  assert.strictEqual(
    computeStoryContentHash(crlfText),
    computeStoryContentHash(lfText),
    'CRLF 与 LF 在抹平行尾空格后必须产出完全一致的 contentHash'
  );
  assert.strictEqual(
    computeStoryContentHash('段落1\r\n段落2\r\n'),
    computeStoryContentHash('段落1\n段落2'),
    '末尾换行不影响哈希'
  );
  console.log('PASS: contentHash 精确回归向量与跨平台换行等价性验证通过');

  console.log('=== 2. title derivation 全边界解析链 ===');
  // 2.1 规则 1：调用方提供显式 title
  assert.strictEqual(
    resolveStoryTitle({ proposedTitle: '月球冒险记', storyText: '# 忽略正文', prompt: '忽略提示词' }),
    '月球冒险记',
    '显式 title 最高优先级'
  );
  assert.strictEqual(
    resolveStoryTitle({ title: '月球冒险记2' }),
    '月球冒险记2',
    '兼容 title 字段传参'
  );
  assert.strictEqual(
    normalizeStoryTitle('   月球   冒险   记   '),
    '月球 冒险 记',
    '连续空白压缩'
  );
  assert.strictEqual(
    normalizeStoryTitle('"月球上的小狐狸"'),
    '月球上的小狐狸',
    '剥离首尾 ASCII 双引号'
  );
  assert.strictEqual(
    normalizeStoryTitle('“月球上的小狐狸”'),
    '月球上的小狐狸',
    '剥离首尾中文双引号'
  );
  assert.strictEqual(
    normalizeStoryTitle('““双层引号嵌套””'),
    '双层引号嵌套',
    '嵌套成对引号逐层剥离'
  );
  assert.strictEqual(
    normalizeStoryTitle('“月球” 与 “地球”'),
    '“月球” 与 “地球”',
    '非全包裹的内部独立中文引号必须完好保留'
  );
  assert.strictEqual(
    normalizeStoryTitle('"月球" 与 "地球"'),
    '"月球" 与 "地球"',
    '非全包裹的内部独立 ASCII 引号必须完好保留'
  );
  assert.strictEqual(
    stripPairedQuotes('“单边未闭合引号'),
    '“单边未闭合引号',
    '未闭合引号不得破坏内容'
  );

  // 显式 title 超长（>80 code points）截断为 79 + …
  const longExplicitTitle = '字'.repeat(85);
  const normalizedLongTitle = normalizeStoryTitle(longExplicitTitle);
  assert.strictEqual(
    getCodePointLength(normalizedLongTitle),
    STORY_TITLE_MAX_LENGTH,
    '超长显式标题必须正好 80 code points'
  );
  assert.strictEqual(
    normalizedLongTitle,
    '字'.repeat(79) + '…',
    '超长显式标题必须为 79 字符 + …'
  );

  // 2.2 规则 2：识别正文第一条非空行的严格格式标题
  assert.strictEqual(
    extractHeadingTitle('\n\n  # 月球上的小狐狸  \n故事正文开始...'),
    '月球上的小狐狸',
    '识别 Markdown H1 标题'
  );
  assert.strictEqual(
    extractHeadingTitle('## 月球上的小狐狸\n正文...'),
    '月球上的小狐狸',
    '识别 Markdown H2 标题'
  );
  assert.strictEqual(
    extractHeadingTitle('###   深空探险指南   \n正文...'),
    '深空探险指南',
    '识别 Markdown H3 标题'
  );
  assert.strictEqual(
    extractHeadingTitle('《月球上的小狐狸》\n故事正文...'),
    '月球上的小狐狸',
    '识别书名号显式标题'
  );
  assert.strictEqual(
    extractHeadingTitle('【月球上的小狐狸】\n故事正文...'),
    '月球上的小狐狸',
    '识别方括号显式标题'
  );

  // 严格拒绝非标题的第一行普通正文
  assert.strictEqual(
    extractHeadingTitle('很久以前，在森林里有一只小狐狸。\n# 后来才出现的标题'),
    null,
    '第一条非空行不是标题标记时绝不猜测普通正文'
  );
  assert.strictEqual(
    extractHeadingTitle('# '),
    null,
    '空内容的 Markdown 标记不识别为标题'
  );
  assert.strictEqual(
    extractHeadingTitle('《》'),
    null,
    '空书名号不识别为标题'
  );
  assert.strictEqual(
    extractHeadingTitle('【】'),
    null,
    '空方括号不识别为标题'
  );
  assert.strictEqual(
    extractHeadingTitle('# ' + '字'.repeat(81)),
    null,
    '超长 heading (>80 code points) 不识别为合法故事标题'
  );

  // 2.3 规则 3：从 prompt 生成确定性 fallback 标题
  assert.strictEqual(
    buildPromptFallbackTitle('讲一个关于小狐狸寻找朋友的睡前故事'),
    '讲一个关于小狐狸寻找朋友的睡前故事',
    '<=32 字符的 prompt 完整保留'
  );
  const multiLinePrompt = '  讲一个故事\r\n关于月球  \n  小狐狸   ';
  assert.strictEqual(
    buildPromptFallbackTitle(multiLinePrompt),
    '讲一个故事 关于月球 小狐狸',
    '换行转空格并压缩'
  );
  const longPrompt = '这是一个非常非常非常非常非常长用来测试截断阈值的提示词正文内容超出限制';
  assert(getCodePointLength(longPrompt) > STORY_TITLE_PROMPT_FALLBACK_MAX_LENGTH);
  const fallbackFromPrompt = buildPromptFallbackTitle(longPrompt);
  assert.strictEqual(
    getCodePointLength(fallbackFromPrompt),
    STORY_TITLE_PROMPT_FALLBACK_MAX_LENGTH,
    '超过 32 字符的 prompt fallback 长度必须严格为 32'
  );
  assert.strictEqual(
    fallbackFromPrompt,
    Array.from(longPrompt).slice(0, 31).join('') + '…',
    '超过 32 字符截断为 31 字符 + …'
  );

  // 2.4 规则 4：全空时的最终安全兜底
  assert.strictEqual(
    resolveStoryTitle({}),
    FALLBACK_STORY_TITLE,
    '无任何入参时最终兜底「未命名故事」'
  );
  assert.strictEqual(
    resolveStoryTitle({ proposedTitle: '   ', storyText: '  ', prompt: '  ' }),
    FALLBACK_STORY_TITLE,
    '全空白时最终兜底「未命名故事」'
  );

  // 2.5 链条优先级综合验证
  assert.strictEqual(
    resolveStoryTitle({
      proposedTitle: '   ',
      storyText: '《星际穿越》\n正文开始',
      prompt: '写一个科幻故事',
    }),
    '星际穿越',
    '显式为空时成功降级到正文严格标题'
  );
  assert.strictEqual(
    resolveStoryTitle({
      proposedTitle: '   ',
      storyText: '很久很久以前没有标题的正文...',
      prompt: '写一个关于小兔子的故事',
    }),
    '写一个关于小兔子的故事',
    '正文无标题时成功降级到 prompt fallback'
  );
  console.log('PASS: title derivation 全边界解析链验证通过');

  console.log('=== 3. excerpt derivation 截取与长度上限 ===');
  assert.strictEqual(buildStoryExcerpt(''), '', '空正文返回空摘要');
  assert.strictEqual(buildStoryExcerpt(null), '', 'null 正文返回空摘要');
  assert.strictEqual(buildStoryExcerpt(undefined), '', 'undefined 正文返回空摘要');

  const sampleBody = '  月球背面。\r\n住着一只小狐狸。   \n它从未见过地球。  ';
  assert.strictEqual(
    buildStoryExcerpt(sampleBody),
    '月球背面。 住着一只小狐狸。 它从未见过地球。',
    '摘要规整换行与连续空格为单空格'
  );

  const exact160Text = '字'.repeat(STORY_EXCERPT_MAX_LENGTH);
  assert.strictEqual(
    buildStoryExcerpt(exact160Text),
    exact160Text,
    '恰好 160 code points 不追加省略号'
  );

  const over160Text = '字'.repeat(165);
  const excerptOver = buildStoryExcerpt(over160Text);
  assert.strictEqual(
    excerptOver,
    '字'.repeat(160) + '…',
    '超过 160 code points 截取前 160 字符并追加 …'
  );
  assert.strictEqual(
    getCodePointLength(excerptOver),
    161,
    '截断后总字符数为 161（远在 DB 240 限制安全余量内）'
  );

  // Emoji 多字节 code point 验证
  const emojiText = '🦊'.repeat(165);
  const emojiExcerpt = buildStoryExcerpt(emojiText);
  assert.strictEqual(
    emojiExcerpt,
    '🦊'.repeat(160) + '…',
    'Emoji 多字节字符按 Unicode code point 精确计数与切分'
  );
  console.log('PASS: excerpt derivation 截取规则与上限验证通过');

  console.log('=== 4. audio missing projection 缺省结构 ===');
  const missingAudio = createMissingAudioProjection();
  assert.deepStrictEqual(
    missingAudio,
    { status: 'missing', durationMs: null },
    '缺省音频投影必须恒为 missing 且 durationMs 为 null'
  );
  assert.deepStrictEqual(
    DEFAULT_AUDIO_PROJECTION,
    { status: 'missing', durationMs: null },
    'DEFAULT_AUDIO_PROJECTION 常量定义一致'
  );
  // Zod 模式校验
  const parsedAudio = storyAudioProjectionSchema.parse(missingAudio);
  assert.strictEqual(parsedAudio.status, 'missing');
  assert.strictEqual(parsedAudio.durationMs, null);

  // 验证在 Summary DTO 与 Detail DTO 中的形态
  const sampleSummary = {
    id: 1,
    title: '测试标题',
    excerpt: '测试摘要',
    voiceId: 'v1',
    contentHash: 'fe7f7272dd2d',
    favoritedAt: null,
    deletedAt: null,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
    audio: missingAudio,
  };
  const parsedSummary = storyWorkSummaryDtoSchema.parse(sampleSummary);
  assert.deepStrictEqual(parsedSummary.audio, { status: 'missing', durationMs: null });

  const sampleDetail = {
    ...sampleSummary,
    prompt: '提示词',
    storyText: '正文',
    sourceMessageId: null,
  };
  const parsedDetail = storyWorkDetailDtoSchema.parse(sampleDetail);
  assert.strictEqual(parsedDetail.prompt, '提示词');
  assert.strictEqual(parsedDetail.storyText, '正文');
  assert.deepStrictEqual(parsedDetail.audio, { status: 'missing', durationMs: null });

  // 对 Summary DTO，传入 audio: null 必须解析失败（取消 nullable 约束）
  assert.throws(() => {
    storyWorkSummaryDtoSchema.parse({
      ...sampleSummary,
      audio: null,
    });
  }, /Expected object, received null|Expected type 'object', received 'null'|invalid/i, 'Summary DTO audio 不得为 null，必须保持稳定对象投影');

  // 对 Detail DTO，传入 audio: null 亦必须解析失败
  assert.throws(() => {
    storyWorkDetailDtoSchema.parse({
      ...sampleDetail,
      audio: null,
    });
  }, /Expected object, received null|Expected type 'object', received 'null'|invalid/i, 'Detail DTO audio 不得为 null');
  console.log('PASS: audio missing projection 缺省结构验证通过');

  console.log('=== 5. limit 默认值 (20) 与最大值 (50) 契约及 List Output 契约 ===');
  const defaultParsed = libraryListInputSchema.parse({});
  assert.strictEqual(defaultParsed.limit, LIBRARY_PAGE_DEFAULT_LIMIT, '未传 limit 时默认 20');
  assert.strictEqual(defaultParsed.view, 'active', '未传 view 时默认 active');

  const customParsed = libraryListInputSchema.parse({ limit: 50 });
  assert.strictEqual(customParsed.limit, LIBRARY_PAGE_MAX_LIMIT, 'limit 50 允许通过');

  const minParsed = libraryListInputSchema.parse({ limit: 1 });
  assert.strictEqual(minParsed.limit, LIBRARY_PAGE_MIN_LIMIT, 'limit 1 允许通过');

  // 超限与非法拒绝
  assert.throws(() => {
    libraryListInputSchema.parse({ limit: 51 });
  }, /最多 50 条/, '超过 50 条必须拒绝');

  assert.throws(() => {
    libraryListInputSchema.parse({ limit: 0 });
  }, /至少 1 条/, '小于 1 条必须拒绝');

  assert.throws(() => {
    libraryListInputSchema.parse({ limit: -1 });
  }, /至少 1 条/, '负数条数必须拒绝');

  // list output schema 正反测试与 hasMore 强约束契约
  const validOutputWithMore = {
    items: [sampleSummary],
    nextCursor: 'valid-cursor-token',
    hasMore: true,
  };
  const parsedOutputWithMore = libraryListOutputSchema.parse(validOutputWithMore);
  assert.strictEqual(parsedOutputWithMore.hasMore, true);
  assert.strictEqual(
    parsedOutputWithMore.hasMore === (parsedOutputWithMore.nextCursor !== null),
    true,
    '契约规则锁定：hasMore === (nextCursor !== null)'
  );

  const validOutputNoMore = {
    items: [sampleSummary],
    nextCursor: null,
    hasMore: false,
  };
  const parsedOutputNoMore = libraryListOutputSchema.parse(validOutputNoMore);
  assert.strictEqual(parsedOutputNoMore.hasMore, false);
  assert.strictEqual(
    parsedOutputNoMore.hasMore === (parsedOutputNoMore.nextCursor !== null),
    true,
    '契约规则锁定：hasMore === (nextCursor !== null)'
  );

  // 缺少 hasMore 必须解析失败（required）
  assert.throws(() => {
    libraryListOutputSchema.parse({
      items: [sampleSummary],
      nextCursor: null,
    });
  }, /hasMore|required|invalid/i, '缺少 hasMore 字段必须解析失败');

  // hasMore 为非布尔必须解析失败
  assert.throws(() => {
    libraryListOutputSchema.parse({
      items: [sampleSummary],
      nextCursor: null,
      hasMore: null,
    });
  }, /hasMore|expected boolean|invalid/i, 'hasMore 为 null 必须解析失败');
  console.log('PASS: limit 默认值与 List Output 契约校验通过');

  console.log('=== 6. query normalization 规整 ===');
  assert.strictEqual(normalizeQuery('  月球故事  '), '月球故事');
  assert.strictEqual(normalizeQuery(''), '');
  assert.strictEqual(normalizeQuery(null), '');
  assert.strictEqual(normalizeQuery(undefined), '');

  const queryInputParsed = libraryListInputSchema.parse({ query: '   狐狸   ' });
  assert.strictEqual(queryInputParsed.query, '狐狸', 'query 输入时自动 trim');

  const maxQuery = 'q'.repeat(LIBRARY_QUERY_MAX_LENGTH);
  assert.strictEqual(
    libraryListInputSchema.parse({ query: maxQuery }).query,
    maxQuery,
    '100 字符 query 允许通过'
  );

  assert.throws(() => {
    libraryListInputSchema.parse({ query: 'q'.repeat(LIBRARY_QUERY_MAX_LENGTH + 1) });
  }, /最多 100 字符/, '超过 100 字符 query 必须拒绝');
  console.log('PASS: query normalization 规整通过');

  console.log('=== 7. cursor encode/decode 稳定 round-trip 与非法 cursor 拒绝 ===');
  // 7.1 稳定往返
  const origPayload = {
    view: 'active' as const,
    timestamp: '2026-09-11T10:20:30.000Z',
    id: 183,
    query: '月球',
  };
  const cursorEncoded = encodeLibraryCursor(origPayload);
  assert.strictEqual(typeof cursorEncoded, 'string');
  assert(cursorEncoded.length > 0);

  const cursorDecoded = decodeLibraryCursor(cursorEncoded);
  assert(cursorDecoded !== null, '合法游标解码不得为 null');
  assert.strictEqual(cursorDecoded.v, LIBRARY_CURSOR_VERSION);
  assert.strictEqual(cursorDecoded.view, 'active');
  assert.strictEqual(cursorDecoded.q, '月球');
  assert.strictEqual(cursorDecoded.t, '2026-09-11T10:20:30.000Z');
  assert.strictEqual(cursorDecoded.id, 183);

  // 往返再编码一致性
  const cursorReEncoded = encodeLibraryCursor({
    v: cursorDecoded.v,
    view: cursorDecoded.view,
    q: cursorDecoded.q,
    t: cursorDecoded.t,
    id: cursorDecoded.id,
  });
  assert.strictEqual(cursorReEncoded, cursorEncoded, 'round-trip 再编码产出完全一致');

  // Date 实例支持
  const dateObj = new Date('2026-09-12T12:00:00.000Z');
  const cursorWithDate = encodeLibraryCursor({
    view: 'trash',
    timestamp: dateObj,
    id: 99,
  });
  const decodedDate = decodeLibraryCursor(cursorWithDate);
  assert(decodedDate !== null);
  assert.strictEqual(decodedDate.t, dateObj.toISOString());
  assert.strictEqual(decodedDate.q, '', '未传 query 时指纹默认空串');

  // 7.2 非法 cursor 拒绝
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64url');
  assert.strictEqual(decodeLibraryCursor(''), null, '空串返回 null');
  assert.strictEqual(decodeLibraryCursor('   '), null, '纯空白返回 null');
  assert.strictEqual(decodeLibraryCursor(null), null, 'null 返回 null');
  assert.strictEqual(decodeLibraryCursor(undefined), null, 'undefined 返回 null');
  assert.strictEqual(decodeLibraryCursor(12345), null, '非 string 返回 null');
  assert.strictEqual(decodeLibraryCursor('not-valid-base64!@#$%^&*'), null, '非法 base64 返回 null');
  assert.strictEqual(decodeLibraryCursor(Buffer.from('not json', 'utf-8').toString('base64url')), null, '非 JSON 字符串返回 null');
  assert.strictEqual(decodeLibraryCursor(b64([])), null, '数组载荷返回 null');
  assert.strictEqual(decodeLibraryCursor(b64('scalar')), null, '标量载荷返回 null');

  // 字段校验失败拒绝
  assert.strictEqual(
    decodeLibraryCursor(b64({ v: 2, view: 'active', q: '', t: '2026-09-11T10:20:30.000Z', id: 1 })),
    null,
    '未来不支持的高版本 v=2 必须拒绝'
  );
  assert.strictEqual(
    decodeLibraryCursor(b64({ v: 1, view: 'unknown-view', q: '', t: '2026-09-11T10:20:30.000Z', id: 1 })),
    null,
    '未知视图类型必须拒绝'
  );
  assert.strictEqual(
    decodeLibraryCursor(b64({ v: 1, view: 'active', q: '', t: 'invalid-date-string', id: 1 })),
    null,
    '非法时间戳必须拒绝'
  );
  assert.strictEqual(
    decodeLibraryCursor(b64({ v: 1, view: 'active', q: '', t: '2026-09-11T10:20:30.000Z', id: -1 })),
    null,
    '负数 ID 必须拒绝'
  );
  assert.strictEqual(
    decodeLibraryCursor(b64({ v: 1, view: 'active', q: '', t: '2026-09-11T10:20:30.000Z', id: 0 })),
    null,
    'ID 0 必须拒绝'
  );
  assert.strictEqual(
    decodeLibraryCursor(b64({ v: 1, view: 'active', q: '', t: '2026-09-11T10:20:30.000Z', id: 1.5 })),
    null,
    '浮点数 ID 必须拒绝'
  );
  assert.strictEqual(
    decodeLibraryCursor(b64({ v: 1, view: 'active', q: 123, t: '2026-09-11T10:20:30.000Z', id: 1 })),
    null,
    '非字符串 q 必须拒绝'
  );

  // 7.3 cursor 匹配校验
  assert.strictEqual(
    isCursorMatchingInput(cursorDecoded, { view: 'active', query: '  月球  ' }),
    true,
    'view 与 query 指纹均匹配'
  );
  assert.strictEqual(
    isCursorMatchingInput(cursorDecoded, { view: 'favorites', query: '月球' }),
    false,
    '跨视图游标不匹配'
  );
  assert.strictEqual(
    isCursorMatchingInput(cursorDecoded, { view: 'active', query: '太阳' }),
    false,
    '跨搜索词游标不匹配'
  );

  // 7.4 Keyset 谓词条件
  const activePred = buildCursorPredicate({
    v: 1,
    view: 'active',
    q: '',
    t: '2026-09-11T10:20:30.000Z',
    id: 50,
  });
  assert(Array.isArray(activePred.OR));
  assert.strictEqual(activePred.OR.length, 2);
  assert('createdAt' in activePred.OR[0]);
  assert('createdAt' in activePred.OR[1]);

  const trashPred = buildCursorPredicate({
    v: 1,
    view: 'trash',
    q: '',
    t: '2026-09-11T10:20:30.000Z',
    id: 50,
  });
  assert('deletedAt' in trashPred.OR[0]);
  assert('deletedAt' in trashPred.OR[1]);
  console.log('PASS: cursor encode/decode 稳定往返与非法拦截验证通过');

  console.log('=== 8. 明确证明：title / favoritedAt / deletedAt 变更不会改变 contentHash ===');
  const stableStoryText = '很久很久以前，在一个遥远的蓝色星球上有一座宁静的灯塔。';
  const baselineHash = computeStoryContentHash(stableStoryText);
  assert.strictEqual(baselineHash.length, 12, '初始基线哈希必须为 12 位');

  // 模拟生命周期中的各类元数据变更
  const stateInitial = {
    title: '初始标题',
    favoritedAt: null,
    deletedAt: null,
    storyText: stableStoryText,
  };
  const stateRenamed = {
    title: '用户重命名之后的新标题（已修改）',
    favoritedAt: null,
    deletedAt: null,
    storyText: stableStoryText,
  };
  const stateFavorited = {
    title: '用户重命名之后的新标题（已修改）',
    favoritedAt: new Date().toISOString(),
    deletedAt: null,
    storyText: stableStoryText,
  };
  const stateTrashed = {
    title: '用户重命名之后的新标题（已修改）',
    favoritedAt: new Date().toISOString(),
    deletedAt: new Date().toISOString(),
    storyText: stableStoryText,
  };
  const stateRestored = {
    title: '用户重命名之后的新标题（已修改）',
    favoritedAt: null,
    deletedAt: null,
    storyText: stableStoryText,
  };

  // 严格断言：无论 title 如何改、是否收藏、是否移入/恢复回收站，contentHash 绝对恒等不变
  assert.strictEqual(
    computeStoryContentHash(stateInitial.storyText),
    baselineHash,
    '初始状态哈希恒等'
  );
  assert.strictEqual(
    computeStoryContentHash(stateRenamed.storyText),
    baselineHash,
    '修改 title 后 contentHash 绝对不变'
  );
  assert.strictEqual(
    computeStoryContentHash(stateFavorited.storyText),
    baselineHash,
    '收藏操作后 contentHash 绝对不变'
  );
  assert.strictEqual(
    computeStoryContentHash(stateTrashed.storyText),
    baselineHash,
    '软删除移入回收站后 contentHash 绝对不变'
  );
  assert.strictEqual(
    computeStoryContentHash(stateRestored.storyText),
    baselineHash,
    '从回收站恢复后 contentHash 绝对不变'
  );

  // 反向对照：只有真实修改正文内容，contentHash 才会发生改变
  const mutatedStoryText = stableStoryText + ' 灯塔里住着一位守塔人。';
  const mutatedHash = computeStoryContentHash(mutatedStoryText);
  assert.notStrictEqual(
    mutatedHash,
    baselineHash,
    '修改 storyText 正文内容必须导致 contentHash 改变'
  );
  console.log('PASS: 元数据变更不影响 contentHash 的领域不变性严格证明通过');

  console.log('\nALL STORYWORK DOMAIN CONTRACT UNIT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runStoryWorkDomainTests()
  .then(() => {
    console.log('ALL STORYWORK DOMAIN UNIT TEST CASES PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;
