-- M5-02 Anchor / Per-Work Persistence Schema（§5 / §6 / §32 Step 1 Expand only）
-- 策略：
-- - 逻辑 rename 用 @@map/@map（UserPlaybackProgress→UserPlaybackAnchor、GuestPlaybackProgress→GuestPlaybackAnchor、sourceType→sourceKind），物理表/列保留；
-- - 新增 anchorState 用 ALTER TABLE ADD COLUMN，避免无意义 SQLite RedefineTables rebuild（吸取 M2 教训）；
-- - 新增 StoryPlaybackProgress / GuestStoryPlaybackProgress（含 StoryWork relation，per-Work 0/1，无 userId/guestId 冗余）；
-- - 不删除任何旧字段/旧表/旧索引；既有数据全部保留。
-- - 本次只做 Expand：不执行 §32 Step 2 canonicalize（chat→draft / generation→work），
--   不执行 Step 3 Existing Work Anchor → Work Progress 回填。
--   原因：当前 runtime 仍读写 chat|generation（DTO / hydrate / writer 未切），提前迁数据会造成
--   “先迁数据、runtime 不会读”的危险中间版本。canonicalization + backfill 移交 M5-03 整体承接。
--
-- M5-03 预埋点（评审指定，不在本轮实现）：
-- - Step 3 的 positive int 检查不得用 GLOB '[0-9]*'（会接受 "001" 这类非 canonical 文本）；
-- - M5-03 须采用等价 fail-closed 检查：String(CAST(sourceId AS INTEGER)) === sourceId AND id > 0。

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
