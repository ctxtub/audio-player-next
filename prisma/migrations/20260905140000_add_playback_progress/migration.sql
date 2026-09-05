-- CreateTable
CREATE TABLE "UserPlaybackProgress" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sessionId" TEXT,
    "title" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL DEFAULT '',
    "segmentationVersion" TEXT NOT NULL DEFAULT 'v1',
    "lastCompletedParagraphIndex" INTEGER NOT NULL DEFAULT -1,
    "nextParagraphIndex" INTEGER NOT NULL DEFAULT 0,
    "totalParagraphs" INTEGER NOT NULL DEFAULT 1,
    "voiceId" TEXT NOT NULL DEFAULT '',
    "speed" REAL NOT NULL DEFAULT 1.0,
    "remainingAllowedMs" INTEGER,
    "totalAllowedMs" INTEGER,
    "isOneShot" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserPlaybackProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GuestPlaybackProgress" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guestId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sessionId" TEXT,
    "title" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL DEFAULT '',
    "segmentationVersion" TEXT NOT NULL DEFAULT 'v1',
    "lastCompletedParagraphIndex" INTEGER NOT NULL DEFAULT -1,
    "nextParagraphIndex" INTEGER NOT NULL DEFAULT 0,
    "totalParagraphs" INTEGER NOT NULL DEFAULT 1,
    "voiceId" TEXT NOT NULL DEFAULT '',
    "speed" REAL NOT NULL DEFAULT 1.0,
    "remainingAllowedMs" INTEGER,
    "totalAllowedMs" INTEGER,
    "isOneShot" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "UserPlaybackProgress_userId_key" ON "UserPlaybackProgress"("userId");

-- CreateIndex
CREATE INDEX "UserPlaybackProgress_userId_idx" ON "UserPlaybackProgress"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GuestPlaybackProgress_guestId_key" ON "GuestPlaybackProgress"("guestId");

-- CreateIndex
CREATE INDEX "GuestPlaybackProgress_guestId_idx" ON "GuestPlaybackProgress"("guestId");

-- CreateIndex
CREATE INDEX "GuestPlaybackProgress_updatedAt_idx" ON "GuestPlaybackProgress"("updatedAt");
