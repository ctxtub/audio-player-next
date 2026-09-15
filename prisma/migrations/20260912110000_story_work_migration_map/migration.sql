-- CreateTable
CREATE TABLE "StoryWorkMigration" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guestId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "guestStoryWorkId" INTEGER NOT NULL,
    "userStoryWorkId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoryWorkMigration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "StoryWorkMigration_guestId_idx" ON "StoryWorkMigration"("guestId");

-- CreateIndex
CREATE INDEX "StoryWorkMigration_userId_idx" ON "StoryWorkMigration"("userId");

-- CreateIndex
CREATE INDEX "StoryWorkMigration_guestStoryWorkId_idx" ON "StoryWorkMigration"("guestStoryWorkId");

-- CreateIndex
CREATE INDEX "StoryWorkMigration_userStoryWorkId_idx" ON "StoryWorkMigration"("userStoryWorkId");

-- CreateIndex
CREATE UNIQUE INDEX "StoryWorkMigration_guestId_guestStoryWorkId_key" ON "StoryWorkMigration"("guestId", "guestStoryWorkId");
