-- StoryWork 数据模型升级：逻辑 rename GenerationHistory → StoryWork
-- 物理表名不变（GenerationHistory / GuestGenerationHistory），仅新增字段与索引。
-- SQLite 不支持 ALTER TABLE ADD COLUMN + DEFAULT + CONSTRAINT 组合，
-- 故采用 Prisma 标准 RedefineTables 策略：新建 → 拷贝 → 删旧 → 重命名。

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GenerationHistory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "storyText" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL DEFAULT '',
    "excerpt" TEXT NOT NULL DEFAULT '',
    "contentHash" TEXT NOT NULL DEFAULT '',
    "sourceMessageId" TEXT,
    "favoritedAt" DATETIME,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GenerationHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_GenerationHistory" ("createdAt", "id", "prompt", "storyText", "userId", "voiceId") SELECT "createdAt", "id", "prompt", "storyText", "userId", "voiceId" FROM "GenerationHistory";
DROP TABLE "GenerationHistory";
ALTER TABLE "new_GenerationHistory" RENAME TO "GenerationHistory";
CREATE INDEX "GenerationHistory_userId_createdAt_id_idx" ON "GenerationHistory"("userId", "createdAt", "id");
CREATE INDEX "GenerationHistory_userId_deletedAt_idx" ON "GenerationHistory"("userId", "deletedAt");
CREATE INDEX "GenerationHistory_userId_favoritedAt_idx" ON "GenerationHistory"("userId", "favoritedAt");
CREATE UNIQUE INDEX "GenerationHistory_userId_sourceMessageId_key" ON "GenerationHistory"("userId", "sourceMessageId");
CREATE TABLE "new_GuestGenerationHistory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guestId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "storyText" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL DEFAULT '',
    "excerpt" TEXT NOT NULL DEFAULT '',
    "contentHash" TEXT NOT NULL DEFAULT '',
    "sourceMessageId" TEXT,
    "favoritedAt" DATETIME,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_GuestGenerationHistory" ("createdAt", "guestId", "id", "prompt", "storyText", "updatedAt", "voiceId") SELECT "createdAt", "guestId", "id", "prompt", "storyText", "updatedAt", "voiceId" FROM "GuestGenerationHistory";
DROP TABLE "GuestGenerationHistory";
ALTER TABLE "new_GuestGenerationHistory" RENAME TO "GuestGenerationHistory";
CREATE INDEX "GuestGenerationHistory_guestId_createdAt_id_idx" ON "GuestGenerationHistory"("guestId", "createdAt", "id");
CREATE INDEX "GuestGenerationHistory_guestId_deletedAt_idx" ON "GuestGenerationHistory"("guestId", "deletedAt");
CREATE INDEX "GuestGenerationHistory_guestId_favoritedAt_idx" ON "GuestGenerationHistory"("guestId", "favoritedAt");
CREATE INDEX "GuestGenerationHistory_guestId_idx" ON "GuestGenerationHistory"("guestId");
CREATE INDEX "GuestGenerationHistory_updatedAt_idx" ON "GuestGenerationHistory"("updatedAt");
CREATE UNIQUE INDEX "GuestGenerationHistory_guestId_sourceMessageId_key" ON "GuestGenerationHistory"("guestId", "sourceMessageId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
