-- M5-03 Legacy Playback Data Canonicalization（spec §5.3 / §32 Step 2 + Step 3）
-- 与 runtime reader/writer 切换同提交对齐（评审裁决）：DB canonical=draft/work；
-- reader 保留四值 chat/generation/draft/work（lib/playback/legacy.ts canonicalizeSourceKind，
-- 至少一个兼容周期）；new writer 只写 canonical（server 侧 canonicalize 后落库）。
-- 本 migration 只做 UPDATE/INSERT，不动表结构（吸取 M2 教训，无 SQLite rebuild）。
--
-- Step 2 — Canonicalize source type（User + Guest 两张 Anchor 表）：
--   chat       → draft
--   generation → work
-- 未知值保持不动（fail-closed，由 reader parser 侧拒绝，不在此静默改写）。
--
-- Step 3 — Existing Work Anchor → Work Progress（User + Guest 对称）：
--   对现存 sourceType='work'（Step 2 已收敛；WHERE 仅匹配 canonical 'work'，
--   与 spec §32“对于现存 sourceKind=work”逐字对齐）Anchor：
--   1. parse sourceId（fail-closed canonical positive int 文本校验）；
--   2. 查 StoryWork（GenerationHistory / GuestGenerationHistory）存在才创建；
--   3. 复制 contentHash / segmentationVersion / lastCompletedParagraphIndex /
--      nextParagraphIndex / totalParagraphs；completedAt=NULL（历史完成态不可重建，
--      当前完播已 clearProgress，库中无历史信息，只迁当前唯一断点）；
--   4. 已存在 Progress（storyWorkId 唯一）则跳过（幂等，不覆盖）；
--   5. lastPlayedAt 取 Anchor.updatedAt（保留最近播放排序），createdAt/updatedAt 取 CURRENT_TIMESTAMP。
--
-- Positive int 校验（评审指定，禁用 GLOB '[0-9]*' 因其接受 "001"）：
--   CAST(CAST("sourceId" AS INTEGER) AS TEXT) = "sourceId" AND CAST("sourceId" AS INTEGER) > 0
-- 即 String(CAST(sourceId AS INTEGER)) === sourceId AND id > 0 的 SQL 等价：
--   "001"/" 1"/"1 "/"0"/"-1"/"1.5"/"1e3"/"0x10"/"" 全部被拒绝（fail-closed，不产生悬空行）；
--   仅 canonical 十进制 positive int 文本（如 "1","481"）通过。
-- sessionId 本项不动（§33 仍 nullable；新写入 UUID 化与 getAnchor repair 属 M5-05）。

-- Step 2 — Canonicalize（User + Guest；幂等，可重跑）
UPDATE "UserPlaybackProgress" SET "sourceType" = 'draft' WHERE "sourceType" = 'chat';
UPDATE "UserPlaybackProgress" SET "sourceType" = 'work' WHERE "sourceType" = 'generation';
UPDATE "GuestPlaybackProgress" SET "sourceType" = 'draft' WHERE "sourceType" = 'chat';
UPDATE "GuestPlaybackProgress" SET "sourceType" = 'work' WHERE "sourceType" = 'generation';

-- Step 3 — Existing Work Anchor → Work Progress（User）
-- 仅 canonical work + canonical positive int 文本 + 对应 StoryWork 存在 + 尚无 Progress 时回填。
INSERT INTO "StoryPlaybackProgress" ("storyWorkId", "contentHash", "segmentationVersion", "lastCompletedParagraphIndex", "nextParagraphIndex", "totalParagraphs", "completedAt", "lastPlayedAt", "createdAt", "updatedAt")
SELECT CAST("sourceId" AS INTEGER), "contentHash", "segmentationVersion", "lastCompletedParagraphIndex", "nextParagraphIndex", "totalParagraphs", NULL, "updatedAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "UserPlaybackProgress"
WHERE "sourceType" = 'work'
  AND CAST(CAST("sourceId" AS INTEGER) AS TEXT) = "sourceId"
  AND CAST("sourceId" AS INTEGER) > 0
  AND EXISTS (SELECT 1 FROM "GenerationHistory" WHERE "GenerationHistory"."id" = CAST("UserPlaybackProgress"."sourceId" AS INTEGER))
  AND NOT EXISTS (SELECT 1 FROM "StoryPlaybackProgress" WHERE "StoryPlaybackProgress"."storyWorkId" = CAST("UserPlaybackProgress"."sourceId" AS INTEGER));

-- Step 3 — Existing Work Anchor → Work Progress（Guest，对称；Work 表为 GuestGenerationHistory）
INSERT INTO "GuestStoryPlaybackProgress" ("storyWorkId", "contentHash", "segmentationVersion", "lastCompletedParagraphIndex", "nextParagraphIndex", "totalParagraphs", "completedAt", "lastPlayedAt", "createdAt", "updatedAt")
SELECT CAST("sourceId" AS INTEGER), "contentHash", "segmentationVersion", "lastCompletedParagraphIndex", "nextParagraphIndex", "totalParagraphs", NULL, "updatedAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "GuestPlaybackProgress"
WHERE "sourceType" = 'work'
  AND CAST(CAST("sourceId" AS INTEGER) AS TEXT) = "sourceId"
  AND CAST("sourceId" AS INTEGER) > 0
  AND EXISTS (SELECT 1 FROM "GuestGenerationHistory" WHERE "GuestGenerationHistory"."id" = CAST("GuestPlaybackProgress"."sourceId" AS INTEGER))
  AND NOT EXISTS (SELECT 1 FROM "GuestStoryPlaybackProgress" WHERE "GuestStoryPlaybackProgress"."storyWorkId" = CAST("GuestPlaybackProgress"."sourceId" AS INTEGER));
