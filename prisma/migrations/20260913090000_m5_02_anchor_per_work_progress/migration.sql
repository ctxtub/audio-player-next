-- M5-02 Anchor / Per-Work Persistence Schema（§5 / §6 / §32 Step 1-3）
-- 策略：
-- - 逻辑 rename 用 @@map/@map（UserPlaybackProgress→UserPlaybackAnchor、GuestPlaybackProgress→GuestPlaybackAnchor、sourceType→sourceKind），物理表/列保留；
-- - 新增 anchorState 用 ALTER TABLE ADD COLUMN，避免无意义 SQLite RedefineTables rebuild（吸取 M2 教训）；
-- - 新增 StoryPlaybackProgress / GuestStoryPlaybackProgress（含 StoryWork relation，per-Work 0/1，无 userId/guestId 冗余）；
-- - 不删除任何旧字段/旧表/旧索引；既有数据全部保留。
-- - Step 2 canonicalize（chat→draft、generation→work，User+Guest）；
-- - Step 3 现存 work Anchor 回填 Work Progress（仅有效 StoryWork 引用，completedAt=null；历史完成态不可重建，只迁当前唯一断点）。

-- 1. Expand schema：anchorState 新增（ADD COLUMN，无 rebuild）
ALTER TABLE "UserPlaybackProgress" ADD COLUMN "anchorState" TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE "GuestPlaybackProgress" ADD COLUMN "anchorState" TEXT NOT NULL DEFAULT 'ready';

-- 2. 新增用户每作品进度表（ownership 经 StoryWork→User，不存 userId）
CREATE TABLE "StoryPlaybackProgress" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "storyWorkId" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL DEFAULT '',
    "segmentationVersion" TEXT NOT NULL DEFAULT 'v1',
    "lastCompletedParagraphIndex" INTEGER NOT NULL DEFAULT -1,
    "nextParagraphIndex" INTEGER NOT NULL DEFAULT 0,
    "totalParagraphs" INTEGER NOT NULL DEFAULT 1,
    "completedAt" DATETIME,
    "lastPlayedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StoryPlaybackProgress_storyWorkId_fkey" FOREIGN KEY ("storyWorkId") REFERENCES "GenerationHistory" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StoryPlaybackProgress_storyWorkId_key" ON "StoryPlaybackProgress"("storyWorkId");
CREATE INDEX "StoryPlaybackProgress_lastPlayedAt_idx" ON "StoryPlaybackProgress"("lastPlayedAt");

-- 3. 新增访客每作品进度表（ownership 经 GuestStoryWork→guest，不存 guestId；Work FK cascade 为主）
CREATE TABLE "GuestStoryPlaybackProgress" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "storyWorkId" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL DEFAULT '',
    "segmentationVersion" TEXT NOT NULL DEFAULT 'v1',
    "lastCompletedParagraphIndex" INTEGER NOT NULL DEFAULT -1,
    "nextParagraphIndex" INTEGER NOT NULL DEFAULT 0,
    "totalParagraphs" INTEGER NOT NULL DEFAULT 1,
    "completedAt" DATETIME,
    "lastPlayedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GuestStoryPlaybackProgress_storyWorkId_fkey" FOREIGN KEY ("storyWorkId") REFERENCES "GuestGenerationHistory" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GuestStoryPlaybackProgress_storyWorkId_key" ON "GuestStoryPlaybackProgress"("storyWorkId");
CREATE INDEX "GuestStoryPlaybackProgress_lastPlayedAt_idx" ON "GuestStoryPlaybackProgress"("lastPlayedAt");
CREATE INDEX "GuestStoryPlaybackProgress_updatedAt_idx" ON "GuestStoryPlaybackProgress"("updatedAt");

-- 4. Step 2 — Canonicalize source type（User + Guest 两张 Anchor 表都执行；新代码 parser 仍兼容四种值至少一个周期）
UPDATE "UserPlaybackProgress" SET "sourceType" = 'draft' WHERE "sourceType" = 'chat';
UPDATE "UserPlaybackProgress" SET "sourceType" = 'work' WHERE "sourceType" = 'generation';
UPDATE "GuestPlaybackProgress" SET "sourceType" = 'draft' WHERE "sourceType" = 'chat';
UPDATE "GuestPlaybackProgress" SET "sourceType" = 'work' WHERE "sourceType" = 'generation';

-- 5. Step 3 — Existing Work Anchor → Work Progress（User）
-- 仅当 sourceId 为 canonical 十进制 positive int 文本且对应 StoryWork 存在时回填；
-- 非法 sourceId / 缺失 Work / 已存在 Progress 一律跳过（fail-closed，不产生悬空行）；
-- 复制 contentHash / segmentationVersion / 段落断点，completedAt=null（历史完成态不可重建）；
-- lastPlayedAt 取 Anchor.updatedAt 以保留最近播放排序。
INSERT INTO "StoryPlaybackProgress" ("storyWorkId", "contentHash", "segmentationVersion", "lastCompletedParagraphIndex", "nextParagraphIndex", "totalParagraphs", "completedAt", "lastPlayedAt", "createdAt", "updatedAt")
SELECT CAST("sourceId" AS INTEGER), "contentHash", "segmentationVersion", "lastCompletedParagraphIndex", "nextParagraphIndex", "totalParagraphs", NULL, "updatedAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "UserPlaybackProgress"
WHERE "sourceType" IN ('work', 'generation')
  AND "sourceId" GLOB '[0-9]*' AND "sourceId" NOT GLOB '*[^0-9]*'
  AND EXISTS (SELECT 1 FROM "GenerationHistory" WHERE "GenerationHistory"."id" = CAST("UserPlaybackProgress"."sourceId" AS INTEGER))
  AND NOT EXISTS (SELECT 1 FROM "StoryPlaybackProgress" WHERE "StoryPlaybackProgress"."storyWorkId" = CAST("UserPlaybackProgress"."sourceId" AS INTEGER));

-- 6. Step 3 — Existing Work Anchor → Work Progress（Guest，对称）
INSERT INTO "GuestStoryPlaybackProgress" ("storyWorkId", "contentHash", "segmentationVersion", "lastCompletedParagraphIndex", "nextParagraphIndex", "totalParagraphs", "completedAt", "lastPlayedAt", "createdAt", "updatedAt")
SELECT CAST("sourceId" AS INTEGER), "contentHash", "segmentationVersion", "lastCompletedParagraphIndex", "nextParagraphIndex", "totalParagraphs", NULL, "updatedAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "GuestPlaybackProgress"
WHERE "sourceType" IN ('work', 'generation')
  AND "sourceId" GLOB '[0-9]*' AND "sourceId" NOT GLOB '*[^0-9]*'
  AND EXISTS (SELECT 1 FROM "GuestGenerationHistory" WHERE "GuestGenerationHistory"."id" = CAST("GuestPlaybackProgress"."sourceId" AS INTEGER))
  AND NOT EXISTS (SELECT 1 FROM "GuestStoryPlaybackProgress" WHERE "GuestStoryPlaybackProgress"."storyWorkId" = CAST("GuestPlaybackProgress"."sourceId" AS INTEGER));
