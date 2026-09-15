-- M9-C1 T3 StoryAudio 单轨资产与秒级进度（spec §2/§4）
-- 策略（expand-only）：
-- - 只新增 4 张表：StoryAudioAsset / GuestStoryAudioAsset / StoryAudioProgress /
--   GuestStoryAudioProgress；不动任何既有表/列/索引（无 SQLite rebuild）；
-- - 零历史回填、零历史 TTS；旧 StoryAudioManifest / StoryAudioSegment 原样保留，
--   由 feature flag 回退（本项不 contract、不物理删除旧 Segment）；
-- - FK 全部 onDelete Cascade（Work → Asset / Progress；DB cascade 只清元数据行，
--   外部 object 清理由 AudioStorageDeletion tombstone 工作流承接）；
-- - 唯一约束：storyWorkId+version（资产世代）、storyWorkId（per-Work 进度 0/1）、
--   storageKey 全局唯一（opaque asset key）。
-- 物理表名即模型名（无 @@map），与既有 M8-01 新增表同风格。

-- 1. User 侧单轨资产
CREATE TABLE "StoryAudioAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storyWorkId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'missing',
    "contentHash" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL,
    "ttsProfileHash" TEXT NOT NULL,
    "synthesisVersion" TEXT NOT NULL,
    "audioFormat" TEXT NOT NULL DEFAULT 'mp3',
    "chunkCount" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'audio/mpeg',
    "byteLength" INTEGER,
    "durationMs" INTEGER,
    "checksum" TEXT,
    "leaseId" TEXT,
    "leaseExpiresAt" DATETIME,
    "lastAccessedAt" DATETIME,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "readyAt" DATETIME,
    "supersededAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StoryAudioAsset_storyWorkId_fkey" FOREIGN KEY ("storyWorkId") REFERENCES "GenerationHistory" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StoryAudioAsset_storageKey_key" ON "StoryAudioAsset"("storageKey");
CREATE UNIQUE INDEX "StoryAudioAsset_storyWorkId_version_key" ON "StoryAudioAsset"("storyWorkId", "version");
CREATE INDEX "StoryAudioAsset_storyWorkId_status_idx" ON "StoryAudioAsset"("storyWorkId", "status");
CREATE INDEX "StoryAudioAsset_status_lastAccessedAt_idx" ON "StoryAudioAsset"("status", "lastAccessedAt");
CREATE INDEX "StoryAudioAsset_leaseExpiresAt_idx" ON "StoryAudioAsset"("leaseExpiresAt");

-- 2. Guest 侧单轨资产
CREATE TABLE "GuestStoryAudioAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storyWorkId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'missing',
    "contentHash" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL,
    "ttsProfileHash" TEXT NOT NULL,
    "synthesisVersion" TEXT NOT NULL,
    "audioFormat" TEXT NOT NULL DEFAULT 'mp3',
    "chunkCount" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'audio/mpeg',
    "byteLength" INTEGER,
    "durationMs" INTEGER,
    "checksum" TEXT,
    "leaseId" TEXT,
    "leaseExpiresAt" DATETIME,
    "lastAccessedAt" DATETIME,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "readyAt" DATETIME,
    "supersededAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GuestStoryAudioAsset_storyWorkId_fkey" FOREIGN KEY ("storyWorkId") REFERENCES "GuestGenerationHistory" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GuestStoryAudioAsset_storageKey_key" ON "GuestStoryAudioAsset"("storageKey");
CREATE UNIQUE INDEX "GuestStoryAudioAsset_storyWorkId_version_key" ON "GuestStoryAudioAsset"("storyWorkId", "version");
CREATE INDEX "GuestStoryAudioAsset_storyWorkId_status_idx" ON "GuestStoryAudioAsset"("storyWorkId", "status");
CREATE INDEX "GuestStoryAudioAsset_status_lastAccessedAt_idx" ON "GuestStoryAudioAsset"("status", "lastAccessedAt");
CREATE INDEX "GuestStoryAudioAsset_leaseExpiresAt_idx" ON "GuestStoryAudioAsset"("leaseExpiresAt");

-- 3. User 侧秒级播放进度
CREATE TABLE "StoryAudioProgress" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "storyWorkId" INTEGER NOT NULL,
    "positionMs" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "sessionId" TEXT NOT NULL DEFAULT '',
    "completedAt" DATETIME,
    "lastPlayedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StoryAudioProgress_storyWorkId_fkey" FOREIGN KEY ("storyWorkId") REFERENCES "GenerationHistory" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StoryAudioProgress_storyWorkId_key" ON "StoryAudioProgress"("storyWorkId");
CREATE INDEX "StoryAudioProgress_lastPlayedAt_idx" ON "StoryAudioProgress"("lastPlayedAt");

-- 4. Guest 侧秒级播放进度
CREATE TABLE "GuestStoryAudioProgress" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "storyWorkId" INTEGER NOT NULL,
    "positionMs" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "sessionId" TEXT NOT NULL DEFAULT '',
    "completedAt" DATETIME,
    "lastPlayedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GuestStoryAudioProgress_storyWorkId_fkey" FOREIGN KEY ("storyWorkId") REFERENCES "GuestGenerationHistory" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GuestStoryAudioProgress_storyWorkId_key" ON "GuestStoryAudioProgress"("storyWorkId");
CREATE INDEX "GuestStoryAudioProgress_lastPlayedAt_idx" ON "GuestStoryAudioProgress"("lastPlayedAt");
CREATE INDEX "GuestStoryAudioProgress_updatedAt_idx" ON "GuestStoryAudioProgress"("updatedAt");
