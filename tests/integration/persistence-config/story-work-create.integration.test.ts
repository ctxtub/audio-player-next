/**
 * StoryWork 创作入库与 sourceMessageId 幂等集成测试（M2-04）
 *
 * 验收矩阵：
 * 1. 创建有效 Work → derived metadata 正确（title/excerpt/hash 与 M2-02 算法一致）→ audio 为 missing projection；
 *    - 验证 caller 传入的伪造 contentHash / excerpt 被服务端权威算法覆盖忽略；
 *    - 验证正文标题提取、prompt fallback 标题、explicit title 显式指定的解析链优先级；
 * 2. 同源同 hash → 返回同一 id、row count 不变（不新增行、不执行 INSERT）；
 * 3. 同源异 hash → CONFLICT 拒绝、原 Work 正文与哈希绝对不被覆盖；
 * 4. sourceMessageId = null / undefined → 不参与幂等，相同正文允许多次创建独立 Work；
 * 5. 彻底摒弃容量裁剪（No count-cap / No delete-oldest / No KEEP_LIMIT）：
 *    - 创建 150 条 → 逐 id 验证第 1 条依然完整存在且总 count=150（不可仅断言 count）；
 * 6. User / Guest 两种 Subject 行为完全对称一致且物理表与租户隔离；
 * 7. 入参边界校验（空正文/空提示词/超长正文/超长提示词均以 BAD_REQUEST 拒绝）。
 */

import assert from 'node:assert';
import { prisma } from '../../../lib/db';
import { TRPCError } from '@trpc/server';
import type { Subject } from '../../../lib/server/subject';
import {
  createStoryWorkForSubject,
  getStoryWorkForSubject,
} from '../../../lib/server/storyWork';
import {
  storyWorkDetailDtoSchema,
} from '../../../lib/trpc/schemas/library';
import {
  resolveStoryTitle,
  buildStoryExcerpt,
  computeStoryContentHash,
} from '../../../lib/storyWork/metadata';

async function runStoryWorkCreateTests() {
  console.log('=== 1. 创建有效 Work 与权威派生元数据（User 主体）===');
  const userTag = Date.now();
  const testUser = await prisma.user.create({
    data: {
      username: `sw_create_u1_${userTag}`,
      password: 'TestPassword123!',
      nickname: 'CreatorTester',
    },
  });
  const userSubject: Subject = { type: 'user', id: testUser.id };

  // 1.1 从 Markdown 标题识别标题，且客户端传入的伪造 contentHash / excerpt 必须被权威算法忽略
  const storyTextWithHeading = '# 月球背面探险记\n在月球的背面，有一座闪闪发光的晶体山脉。小狐狸跳下探测器……';
  const prompt1 = '写一个关于小狐狸在月球探险的睡前故事';
  const expectedHash1 = computeStoryContentHash(storyTextWithHeading);
  const expectedExcerpt1 = buildStoryExcerpt(storyTextWithHeading);
  const expectedTitle1 = resolveStoryTitle({ storyText: storyTextWithHeading, prompt: prompt1 });

  const created1 = await createStoryWorkForSubject(userSubject, {
    prompt: prompt1,
    storyText: storyTextWithHeading,
    voiceId: 'voice_alloy',
    sourceMessageId: 'msg_u1_001',
    // 模拟恶意客户端试图注入虚假 hash 与 excerpt
    ...({
      contentHash: 'malicious_fake_hash',
      excerpt: 'malicious_fake_excerpt',
    } as Record<string, unknown>),
  });

  // 校验 DTO Schema
  const parsed1 = storyWorkDetailDtoSchema.parse(created1);
  assert.strictEqual(parsed1.id, created1.id);
  assert(created1.id > 0, 'id 必须为正整数');
  assert.strictEqual(created1.title, expectedTitle1, '标题必须严格等于服务端算法推导值');
  assert.strictEqual(created1.title, '月球背面探险记');
  assert.strictEqual(created1.excerpt, expectedExcerpt1, '摘要必须严格等于服务端算法推导值');
  assert.notStrictEqual(created1.excerpt, 'malicious_fake_excerpt', '不得信任客户端传入的 excerpt');
  assert.strictEqual(created1.contentHash, expectedHash1, '内容哈希必须严格等于服务端权威哈希');
  assert.notStrictEqual(created1.contentHash, 'malicious_fake_hash', '不得信任客户端传入的 contentHash');
  assert.strictEqual(created1.voiceId, 'voice_alloy');
  assert.strictEqual(created1.sourceMessageId, 'msg_u1_001');
  assert.strictEqual(created1.prompt, prompt1);
  assert.strictEqual(created1.storyText, storyTextWithHeading);
  assert.strictEqual(created1.favoritedAt, null);
  assert.strictEqual(created1.deletedAt, null);
  assert.strictEqual(created1.audio.status, 'missing', 'audio projection status 必须为 missing');
  assert.strictEqual(created1.audio.durationMs, null, 'audio projection durationMs 必须为 null');
  console.log('PASS: 1.1 有效 Work 权威元数据与 missing audio 投影校验通过');

  // 1.2 无标题格式时回退至 Prompt Fallback 标题
  const storyTextNoHeading = '很久很久以前，森林深处住着三只小松鼠，他们每天收集松果。';
  const prompt2 = '编写一个关于三只小松鼠团结合作的故事';
  const created2 = await createStoryWorkForSubject(userSubject, {
    prompt: prompt2,
    storyText: storyTextNoHeading,
    sourceMessageId: 'msg_u1_002',
  });
  const expectedTitle2 = resolveStoryTitle({ storyText: storyTextNoHeading, prompt: prompt2 });
  assert.strictEqual(created2.title, expectedTitle2);
  assert.strictEqual(created2.title, '编写一个关于三只小松鼠团结合作的故事');
  assert.strictEqual(created2.voiceId, '', '缺省 voiceId 应规范化为空串');
  console.log('PASS: 1.2 Prompt Fallback 标题派生校验通过');

  // 1.3 显式 explicit title 具有最高优先级（即使正文有标题）
  const created3 = await createStoryWorkForSubject(userSubject, {
    title: '“显式指定的自定义松鼠故事”',
    prompt: prompt2,
    storyText: storyTextWithHeading, // 正文有 # 月球背面探险记
    sourceMessageId: 'msg_u1_003',
  });
  assert.strictEqual(created3.title, '显式指定的自定义松鼠故事', '显式 title 剥离引号后优先于正文标题');
  console.log('PASS: 1.3 显式 explicit title 优先级校验通过');

  console.log('=== 2. 同源同 hash 幂等（返回同一 id、row count 不变）===');
  const countBeforeIdempotent = await prisma.storyWork.count({ where: { userId: testUser.id } });

  // 再次传入相同 subject + 相同 sourceMessageId + 相同正文（contentHash 一致）
  const idempotentResult = await createStoryWorkForSubject(userSubject, {
    prompt: '即便提示词略微修改',
    storyText: storyTextWithHeading, // 相同正文 → 相同 contentHash
    sourceMessageId: 'msg_u1_001',
    voiceId: 'voice_other',
  });

  assert.strictEqual(idempotentResult.id, created1.id, '幂等调用必须返回已有 Work 的同一 ID');
  assert.strictEqual(idempotentResult.contentHash, created1.contentHash);
  assert.strictEqual(idempotentResult.storyText, storyTextWithHeading);
  assert.strictEqual(idempotentResult.prompt, prompt1, '幂等返回已有 Work，不得被修改');
  assert.strictEqual(idempotentResult.voiceId, 'voice_alloy', '原音色不得被覆盖');

  const countAfterIdempotent = await prisma.storyWork.count({ where: { userId: testUser.id } });
  assert.strictEqual(countAfterIdempotent, countBeforeIdempotent, '同源同 hash 幂等调用不得新增数据库行');
  console.log('PASS: 同源同 hash 幂等返回同一 id 且行数完全不变');

  console.log('=== 3. 同源异 hash 冲突（CONFLICT、原 Work 不被覆盖）===');
  const countBeforeConflict = await prisma.storyWork.count({ where: { userId: testUser.id } });

  let conflictThrown = false;
  try {
    // 传入相同 sourceMessageId，但正文不同（导致 contentHash 不一致）
    await createStoryWorkForSubject(userSubject, {
      prompt: '换一个完全不同的故事',
      storyText: '这是完全不同的正文内容，哈希必然漂移……',
      sourceMessageId: 'msg_u1_001',
    });
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'CONFLICT') {
      conflictThrown = true;
    } else {
      throw err;
    }
  }
  assert.strictEqual(conflictThrown, true, '同源异 hash 必须抛出明确 CONFLICT 错误');

  // 严密验证数据库原 Work 绝对未被修改与覆盖
  const originalRow = await prisma.storyWork.findUnique({
    where: { id: created1.id },
  });
  assert(originalRow !== null);
  assert.strictEqual(originalRow.storyText, storyTextWithHeading, '原 Work 正文绝不可被覆盖');
  assert.strictEqual(originalRow.contentHash, expectedHash1, '原 Work contentHash 绝不可被覆盖');
  assert.strictEqual(originalRow.prompt, prompt1, '原 Work prompt 绝不可被覆盖');

  const countAfterConflict = await prisma.storyWork.count({ where: { userId: testUser.id } });
  assert.strictEqual(countAfterConflict, countBeforeConflict, '冲突发生时不得插入新行');
  console.log('PASS: 同源异 hash 严格报 CONFLICT 且原正文完好无损');

  console.log('=== 4. sourceMessageId = null / undefined 同内容多次创建 ===');
  const countBeforeNullSource = await prisma.storyWork.count({ where: { userId: testUser.id } });

  const duplicateStoryText = '这是一个没有 sourceMessageId 的独立故事内容。';
  const dup1 = await createStoryWorkForSubject(userSubject, {
    prompt: '测试无来源消息创建 1',
    storyText: duplicateStoryText,
    sourceMessageId: null,
  });

  const dup2 = await createStoryWorkForSubject(userSubject, {
    prompt: '测试无来源消息创建 2',
    storyText: duplicateStoryText,
    sourceMessageId: null,
  });

  const dup3 = await createStoryWorkForSubject(userSubject, {
    prompt: '测试无来源消息创建 3',
    storyText: duplicateStoryText,
    // sourceMessageId 缺省 undefined
  });

  assert(dup1.id > 0);
  assert(dup2.id > 0);
  assert(dup3.id > 0);
  assert.notStrictEqual(dup1.id, dup2.id, 'sourceMessageId=null 两次创建必须生成两个独立作品');
  assert.notStrictEqual(dup2.id, dup3.id, 'sourceMessageId 缺省与 null 两次创建必须生成独立作品');
  assert.notStrictEqual(dup1.id, dup3.id);
  assert.strictEqual(dup1.sourceMessageId, null);
  assert.strictEqual(dup2.sourceMessageId, null);
  assert.strictEqual(dup3.sourceMessageId, null);

  const countAfterNullSource = await prisma.storyWork.count({ where: { userId: testUser.id } });
  assert.strictEqual(countAfterNullSource, countBeforeNullSource + 3, '三次无来源消息创建必须各新增一行');
  console.log('PASS: sourceMessageId=null 同内容多次创建生成独立 Works');

  console.log('=== 5. 彻底摒弃容量裁剪：创建 150 条 → 逐 id 验证第 1 条仍在且 count=150 ===');
  const testUser150 = await prisma.user.create({
    data: {
      username: `sw_cap_150_${userTag}`,
      password: 'TestPassword123!',
      nickname: 'Retention150Tester',
    },
  });
  const subject150: Subject = { type: 'user', id: testUser150.id };

  const created150Ids: number[] = [];
  const firstPrompt = '第 001 条故事提示词：遥远银河系';
  const firstStoryText = '# 银河之门\n在遥远的银河系边缘，星舰穿梭在星云之间。';

  for (let i = 1; i <= 150; i++) {
    const prompt = i === 1 ? firstPrompt : `第 ${String(i).padStart(3, '0')} 条故事提示词`;
    const storyText = i === 1 ? firstStoryText : `第 ${String(i).padStart(3, '0')} 条故事正文内容……`;
    const res = await createStoryWorkForSubject(subject150, {
      prompt,
      storyText,
      voiceId: 'voice_cap',
      sourceMessageId: `msg_150_${i}`,
    });
    created150Ids.push(res.id);
  }

  assert.strictEqual(created150Ids.length, 150, '必须成功返回 150 个创建结果');

  // 1. 断言总行数恰为 150
  const totalCount150 = await prisma.storyWork.count({ where: { userId: testUser150.id } });
  assert.strictEqual(totalCount150, 150, '创建 150 条后数据库总行数必须为 150（无任何裁剪）');

  // 2. 逐 ID 验证：第 1 条依然完整存在，未被任何 KEEP_LIMIT / delete-oldest 策略裁剪
  const firstWork = await getStoryWorkForSubject(subject150, created150Ids[0]);
  assert.strictEqual(firstWork.id, created150Ids[0], '第 1 条作品必须能够被正常读取');
  assert.strictEqual(firstWork.title, '银河之门', '第 1 条作品标题必须完好');
  assert.strictEqual(firstWork.prompt, firstPrompt, '第 1 条作品提示词必须完好');
  assert.strictEqual(firstWork.storyText, firstStoryText, '第 1 条作品正文必须完好');

  // 3. 逐 ID 验证第 100 条（旧门限边缘）与第 101 条（旧删除触发点）
  const work100 = await getStoryWorkForSubject(subject150, created150Ids[99]);
  assert.strictEqual(work100.id, created150Ids[99]);
  const work101 = await getStoryWorkForSubject(subject150, created150Ids[100]);
  assert.strictEqual(work101.id, created150Ids[100]);

  // 4. 批量验证全部 150 个 ID 全部完好在库
  const presentRows = await prisma.storyWork.findMany({
    where: {
      userId: testUser150.id,
      id: { in: created150Ids },
    },
    select: { id: true },
  });
  assert.strictEqual(presentRows.length, 150, '全部 150 个生成的 ID 必须逐条存在于数据库中');
  console.log('PASS: 150 条作品全量保留，第 1 条与全部 ID 均在库，无任何容量裁剪');

  console.log('=== 6. User / Guest 两种 Subject 行为完全一致性与租户隔离 ===');
  const guestIdA = `g_create_test_a_${userTag}`;
  const guestIdB = `g_create_test_b_${userTag}`;
  const guestSubjectA: Subject = { type: 'guest', id: guestIdA };
  const guestSubjectB: Subject = { type: 'guest', id: guestIdB };

  // 6.1 Guest 创建有效作品
  const guestPrompt = '访客主体提示词：森林里的小松鼠';
  const guestStoryText = '# 森林奇遇记\n小松鼠正在搬运松果……';
  const guestCreated = await createStoryWorkForSubject(guestSubjectA, {
    prompt: guestPrompt,
    storyText: guestStoryText,
    voiceId: 'voice_guest',
    sourceMessageId: 'msg_guest_001',
  });

  const parsedGuest = storyWorkDetailDtoSchema.parse(guestCreated);
  assert.strictEqual(parsedGuest.title, '森林奇遇记');
  assert.strictEqual(parsedGuest.contentHash, computeStoryContentHash(guestStoryText));
  assert.strictEqual(parsedGuest.excerpt, buildStoryExcerpt(guestStoryText));
  assert.strictEqual(parsedGuest.audio.status, 'missing');
  assert.strictEqual(parsedGuest.sourceMessageId, 'msg_guest_001');

  // 6.2 Guest 同源同 hash 幂等
  const guestIdempotent = await createStoryWorkForSubject(guestSubjectA, {
    prompt: '无论怎么传 prompt',
    storyText: guestStoryText,
    sourceMessageId: 'msg_guest_001',
  });
  assert.strictEqual(guestIdempotent.id, guestCreated.id, '访客同源同 hash 必须返回同一 ID');
  const guestCountA = await prisma.guestStoryWork.count({ where: { guestId: guestIdA } });
  assert.strictEqual(guestCountA, 1, '访客幂等调用不得增加行数');

  // 6.3 Guest 同源异 hash CONFLICT
  let guestConflict = false;
  try {
    await createStoryWorkForSubject(guestSubjectA, {
      prompt: '不同故事',
      storyText: '不同正文内容，导致哈希不一致',
      sourceMessageId: 'msg_guest_001',
    });
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'CONFLICT') {
      guestConflict = true;
    }
  }
  assert.strictEqual(guestConflict, true, '访客同源异 hash 必须抛出 CONFLICT');

  // 6.4 Guest 物理隔离与跨主体同名 sourceMessageId 互不干扰
  // 6.4.1 Guest B 使用相同 sourceMessageId 创建不冲突
  const guestBCreated = await createStoryWorkForSubject(guestSubjectB, {
    prompt: 'Guest B 的故事',
    storyText: '# Guest B 故事\n正文B……',
    sourceMessageId: 'msg_guest_001',
  });
  assert(guestBCreated.id > 0);
  assert.notStrictEqual(guestBCreated.id, guestCreated.id, '不同访客同 sourceMessageId 互不影响');

  // 6.4.2 User 使用相同 sourceMessageId 创建与 Guest 不冲突
  const userSameSource = await createStoryWorkForSubject(userSubject, {
    prompt: 'User 侧使用同名 sourceMessageId',
    storyText: '# 用户侧故事\n正文内容……',
    sourceMessageId: 'msg_guest_001',
  });
  assert(userSameSource.id > 0);
  assert.notStrictEqual(userSameSource.id, guestCreated.id);

  // 6.5 Guest 150 条容量保留（无裁剪）
  const guestCapId = `g_cap_150_${userTag}`;
  const guestCapSubject: Subject = { type: 'guest', id: guestCapId };
  const guest150Ids: number[] = [];
  for (let i = 1; i <= 150; i++) {
    const res = await createStoryWorkForSubject(guestCapSubject, {
      prompt: `访客提示词-${i}`,
      storyText: `访客故事正文内容-${i}……`,
      sourceMessageId: `msg_g150_${i}`,
    });
    guest150Ids.push(res.id);
  }
  const guestCapCount = await prisma.guestStoryWork.count({ where: { guestId: guestCapId } });
  assert.strictEqual(guestCapCount, 150, '访客创建 150 条总行数必须为 150');
  const guestFirst = await getStoryWorkForSubject(guestCapSubject, guest150Ids[0]);
  assert.strictEqual(guestFirst.id, guest150Ids[0], '访客第 1 条作品未被裁剪且可正常读取');
  console.log('PASS: User 与 Guest 主体行为完全一致且数据物理隔离');

  console.log('=== 7. 入参边界校验（BAD_REQUEST）===');
  // 7.1 空提示词
  await assert.rejects(
    createStoryWorkForSubject(userSubject, {
      prompt: '',
      storyText: '正常故事正文',
    }),
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    '空提示词应抛 BAD_REQUEST'
  );

  // 7.2 空正文
  await assert.rejects(
    createStoryWorkForSubject(userSubject, {
      prompt: '正常提示词',
      storyText: '',
    }),
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    '空故事正文应抛 BAD_REQUEST'
  );

  // 7.3 超长提示词 (> 2000 字符)
  await assert.rejects(
    createStoryWorkForSubject(userSubject, {
      prompt: 'A'.repeat(2001),
      storyText: '正常故事正文',
    }),
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    '超长提示词应抛 BAD_REQUEST'
  );

  // 7.4 超长正文 (> 20000 字符)
  await assert.rejects(
    createStoryWorkForSubject(userSubject, {
      prompt: '正常提示词',
      storyText: 'B'.repeat(20001),
    }),
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    '超长正文应抛 BAD_REQUEST'
  );
  console.log('PASS: 入参边界非法格式拒绝校验通过');
}

const testPromise = runStoryWorkCreateTests()
  .then(() => {
    console.log('ALL STORYWORK CREATE SERVICE INTEGRATION TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('StoryWork create service integration test failed:', err);
    process.exit(1);
  });

export default testPromise;
