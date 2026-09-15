-- M8-01 Schema & Manifest Identity Foundation（spec §5.1/§6/§29 + §37 Step A Schema expand）
-- 策略（expand-only）：
-- - 只新增 5 张表：StoryAudioManifest / StoryAudioSegment / GuestStoryAudioManifest /
--   GuestStoryAudioSegment / AudioStorageDeletion；不动任何既有表/列/索引（无 SQLite rebuild）；
-- - 零历史回填：不批量迁移历史 StoryWork、不触发任何历史 TTS；
--   旧 Work 无 Manifest 行，M2 投影自动为 audio.status=missing（spec §37）；
-- - FK 全部 onDelete Cascade（Work → Manifest → Segment；spec §28.4 注：DB cascade 只清元数据行，
--   外部 object 清理由 M8-05 tombstone 工作流承接，本项只建 tombstone 表）；
-- - 唯一约束：storyWorkId+version（Manifest 世代）、manifestId+segmentIndex（Segment 序号）、
--   storageKey 全局唯一（opaque asset key）。
-- 物理表名即模型名（无 @@map），与既有 M5-02 新增表同风格。

-- 1. User 侧 Manifest（spec §5.1）
CREATE TABLE "StoryAudioManifest" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "storyWorkId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'missing',
    "contentHash" TEXT NOT NULL,
    "segmentationVersion" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL,
    "ttsBackendId" TEXT NOT NULL,
    "ttsModel" TEXT NOT NULL,
    "synthesisVersion" TEXT NOT NULL,
    "synthesisSpeed" REAL NOT NULL DEFAULT 1.0,
    "audioFormat" TEXT NOT NULL DEFAULT 'mp3',
    "segmentCount" INTEGER NOT NULL,
    "readySegmentCount" INTEGER NOT NULL DEFAULT 0,
    "totalDurationMs" INTEGER,
    "totalByteLength" INTEGER,
    "lastErrorCode" TEXT,
    "readyAt" DATETIME,
    "supersededAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StoryAudioManifest_storyWorkId_fkey" FOREIGN KEY ("storyWorkId") REFERENCES "GenerationHistory" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StoryAudioManifest_storyWorkId_version_key" ON "StoryAudioManifest"("storyWorkId", "version");
CREATE INDEX "StoryAudioManifest_storyWorkId_status_idx" ON "StoryAudioManifest"("storyWorkId", "status");
CREATE INDEX "StoryAudioManifest_status_updatedAt_idx" ON "StoryAudioManifest"("status", "updatedAt");

-- 2. User 侧 Segment（spec §6；id 为 service 生成的 UUID 文本，无 DB 默认，强制显式生成）
CREATE TABLE "StoryAudioSegment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "manifestId" INTEGER NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'missing',
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'audio/mpeg',
    "byteLength" INTEGER,
    "durationMs" INTEGER,
    "audioChecksum" TEXT,
    "leaseId" TEXT,
    "leaseExpiresAt" DATETIME,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "readyAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StoryAudioSegment_manifestId_fkey" FOREIGN KEY ("manifestId") REFERENCES "StoryAudioManifest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StoryAudioSegment_storageKey_key" ON "StoryAudioSegment"("storageKey");
CREATE UNIQUE INDEX "StoryAudioSegment_manifestId_segmentIndex_key" ON "StoryAudioSegment"("manifestId", "segmentIndex");
CREATE INDEX "StoryAudioSegment_manifestId_status_idx" ON "StoryAudioSegment"("manifestId", "status");
CREATE INDEX "StoryAudioSegment_leaseExpiresAt_idx" ON "StoryAudioSegment"("leaseExpiresAt");

-- 3. Guest 侧 Manifest（与 User 对称；Work 物理表为 GuestGenerationHistory）
CREATE TABLE "GuestStoryAudioManifest" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "storyWorkId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'missing',
    "contentHash" TEXT NOT NULL,
    "segmentationVersion" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL,
    "ttsBackendId" TEXT NOT NULL,
    "ttsModel" TEXT NOT NULL,
    "synthesisVersion" TEXT NOT NULL,
    "synthesisSpeed" REAL NOT NULL DEFAULT 1.0,
    "audioFormat" TEXT NOT NULL DEFAULT 'mp3',
    "segmentCount" INTEGER NOT NULL,
    "readySegmentCount" INTEGER NOT NULL DEFAULT 0,
    "totalDurationMs" INTEGER,
    "totalByteLength" INTEGER,
    "lastErrorCode" TEXT,
    "readyAt" DATETIME,
    "supersededAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GuestStoryAudioManifest_storyWorkId_fkey" FOREIGN KEY ("storyWorkId") REFERENCES "GuestGenerationHistory" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GuestStoryAudioManifest_storyWorkId_version_key" ON "GuestStoryAudioManifest"("storyWorkId", "version");
CREATE INDEX "GuestStoryAudioManifest_storyWorkId_status_idx" ON "GuestStoryAudioManifest"("storyWorkId", "status");
CREATE INDEX "GuestStoryAudioManifest_status_updatedAt_idx" ON "GuestStoryAudioManifest"("status", "updatedAt");

-- 4. Guest 侧 Segment（与 User 对称）
CREATE TABLE "GuestStoryAudioSegment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "manifestId" INTEGER NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'missing',
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'audio/mpeg',
    "byteLength" INTEGER,
    "durationMs" INTEGER,
    "audioChecksum" TEXT,
    "leaseId" TEXT,
    "leaseExpiresAt" DATETIME,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "readyAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GuestStoryAudioSegment_manifestId_fkey" FOREIGN KEY ("manifestId") REFERENCES "GuestStoryAudioManifest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GuestStoryAudioSegment_storageKey_key" ON "GuestStoryAudioSegment"("storageKey");
CREATE UNIQUE INDEX "GuestStoryAudioSegment_manifestId_segmentIndex_key" ON "GuestStoryAudioSegment"("manifestId", "segmentIndex");
CREATE INDEX "GuestStoryAudioSegment_manifestId_status_idx" ON "GuestStoryAudioSegment"("manifestId", "status");
CREATE INDEX "GuestStoryAudioSegment_leaseExpiresAt_idx" ON "GuestStoryAudioSegment"("leaseExpiresAt");

-- 5. Audio 对象删除 tombstone（spec §29；真删除/GC/cleanup 工作流留 M8-05，本项只建表）
CREATE TABLE "AudioStorageDeletion" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "storageKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "AudioStorageDeletion_storageKey_key" ON "AudioStorageDeletion"("storageKey");
CREATE INDEX "AudioStorageDeletion_nextAttemptAt_idx" ON "AudioStorageDeletion"("nextAttemptAt");
